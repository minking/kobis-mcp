#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ProtocolError } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
/**
 * kobis-mcp — MCP 공식 TypeScript SDK v2 + 프로토콜 리비전 2026-07-28 기반 서버
 *
 * (정식 표준: 2026-07-28. 최초 공개 버전은 2024-11-05이었으며, 대대적인 무상태(stateless)
 *  개편을 거쳐 현재 표준에 도달했습니다.)
 *
 * 최신 스펙(v2 / 2026-07-28) 반영 사항:
 * 1. [Stateless 우선] 2026-07-28 리비전은 세션(Mcp-Session-Id) 없는 요청 단위(per-request)
 *    프로토콜입니다. initialize 핸드셰이크와 세션 상태에 의존하지 않는 순수 도구 핸들러로
 *    작성했으며, Rate limiter 큐를 서버 팩토리(createServer) 내부 클로저로 캡슐화하여
 *    serveStdio/connection-pinning·createMcpHandler/per-request 어느 배포 방식으로도
 *    확장(scale-to-zero, 로드밸런서 라운드롭) 가능합니다.
 * 2. [양쪽 시대 지원] v2의 `serveStdio(factory)` 연결 고정(pinned) 엔트리포인트로 접속
 *    첫 교환에서 에라(era)를 협상 — 2026-07-28 모던 클라이언트는 `server/discover` +
 *    per-request `_meta` envelope(SEP-2243)로, 2025-era 레거시 클라이언트(Claude Desktop,
 *    Cursor 등)는 기존 initialize 핸드셰이커로 동일 팩토리가 서빙됩니다.
 * 3. [v2 패키지 구조] `@modelcontextprotocol/sdk`(v1) 제거, 공식 1티어 v2 패키지로 이전:
 *    `@modelcontextprotocol/server`(McpServer, createMcpHandler, serveStdio),
 *    스펙 Zod 스키마는 `@modelcontextprotocol/core`로 분리.
 * 4. [Standard Schema + Strict Tools] Zod ≥4.2(현재 ^4.6)의 `~standard.jsonSchema`
 *    자체 변환 경로로 input/output 스키마를 선언, .strict()로 미지 파라미터 차단,
 *    outputSchema로 structuredContent 라운드트립 검증.
 * 5. [v2 에러 체계] McpError → ProtocolError(ProtocolErrorCode)로 이름 변경된 wire-through
 *    프로토콜 에러만 상방 전파하고, 애플리케이션 오류(KOBIS 키 누락/HTTP/faultInfo)는
 *    CallToolResult.isError 인밴드 채널로 전달(JSON-RPC -32602 vs isError 이중 채널 유지).
 * 6. [Tool Annotations] 모든 조회 도구에 readOnlyHint/openWorldHint 명시.
 * 7. [Node 내장 fetch] 외부 폴리필 없이 Node 20+ 내장 fetch/AbortSignal.timeout 사용.
 */
const BASE_URL = 'https://www.kobis.or.kr/kobisopenapi/webservice/rest';
export const RATE_LIMIT_MS = 250;
const USER_AGENT = 'kobis-mcp/2.0.0';
export function createRateLimiter() {
    let queue = Promise.resolve();
    let lastCompletedTime = 0;
    return {
        enqueue(task, intervalMs = RATE_LIMIT_MS) {
            const next = queue.then(async () => {
                const elapsed = Date.now() - lastCompletedTime;
                if (elapsed < intervalMs) {
                    await new Promise((r) => setTimeout(r, intervalMs - elapsed));
                }
                try {
                    return await task();
                }
                finally {
                    lastCompletedTime = Date.now();
                }
            });
            // 체인 자체는 에러가 전파되지 않도록 격리 (대기열 무너짐 방지)
            queue = next.catch(() => { });
            return next;
        }
    };
}
// 테스트 하위 호환용 기본 리미터
const defaultLimiter = createRateLimiter();
export const enqueue = defaultLimiter.enqueue.bind(defaultLimiter);
// ---------------------------------------------------------------------------
// KOBIS 클라이언트 (Node 내장 fetch)
// ---------------------------------------------------------------------------
export class KobisHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'KobisHttpError';
    }
}
export class KobisApiError extends Error {
    errorCode;
    constructor(errorCode, message) {
        super(`[KOBIS ${errorCode}] ${message}`);
        this.errorCode = errorCode;
        this.name = 'KobisApiError';
    }
}
export async function fetchKobisWith(limiter, endpoint, params) {
    const key = process.env.KOBIS_API_KEY;
    if (!key)
        throw new Error('KOBIS_API_KEY 환경변수가 설정되지 않았습니다.');
    return limiter.enqueue(async () => {
        const searchParams = new URLSearchParams({ key });
        for (const [k, v] of Object.entries(params)) {
            if (v != null && v !== '')
                searchParams.set(k, String(v));
        }
        // Node 20+ 내장 fetch (외부 폴리필 미사용)
        const res = await fetch(`${BASE_URL}${endpoint}?${searchParams}`, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) {
            throw new KobisHttpError(res.status, `KOBIS HTTP 오류: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        if (data?.faultInfo) {
            throw new KobisApiError(String(data.faultInfo.errorCode || 'ERROR'), String(data.faultInfo.message));
        }
        return data;
    });
}
// ---------------------------------------------------------------------------
// 최신 Strict Tools 방식 toolHandler
// ---------------------------------------------------------------------------
/**
 * stateless 순수 핸들러: 세션/initialize 상태에 의존하지 않습니다.
 * 최신 스펙의 CallToolResult 규격에 따라 isError 결과에는 structuredContent를 포함하지 않으며,
 * KOBIS 오류(키 누락/HTTP/faultInfo)는 isError 결과로 전달합니다.
 */
export function makeToolHandler(endpoint, limiter) {
    return async (args) => {
        try {
            const res = await fetchKobisWith(limiter, endpoint, args ?? {});
            return {
                content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
                structuredContent: res
            };
        }
        catch (err) {
            if (err instanceof ProtocolError)
                throw err;
            return {
                content: [{ type: 'text', text: `오류: ${err?.message ?? err}` }],
                isError: true
            };
        }
    };
}
// 레거시 export 호환 (테스트/서드파티 재사용 고려)
export function toolHandler(fn) {
    return async (args) => {
        try {
            const res = await fn(args);
            return {
                content: [{ type: 'text', text: typeof res === 'string' ? res : JSON.stringify(res, null, 2) }]
            };
        }
        catch (err) {
            if (err instanceof ProtocolError)
                throw err;
            return { content: [{ type: 'text', text: `오류: ${err?.message ?? err}` }], isError: true };
        }
    };
}
// ---------------------------------------------------------------------------
// Zod v4 Strict 스키마 (미지의 파라미터 차단: additionalProperties:false)
// ---------------------------------------------------------------------------
const targetDt = z.string().regex(/^\d{8}$/, 'YYYYMMDD 형식(8자리 숫자)이어야 합니다');
const digits = z.string().regex(/^\d+$/, '숫자만 입력 가능합니다');
export const pageSchema = {
    curPage: digits.optional().describe('페이지 번호 (기본 1)'),
    itemPerPage: digits.optional().describe('페이지당 건수 (기본 10)')
};
export const targetDtSchema = targetDt;
// strict object 빌더: shape → .strict() (최신 Strict Tools 권장 패턴)
const strictObj = (shape) => z.object(shape).strict();
// KOBIS 원본 응답 공통 출력 스키마 (passthrough 유지 — unknown 필드 허용)
const listOutput = (key, itemKey) => z
    .object({
    [key]: z
        .object({
        pageNo: z.union([z.number(), z.string()]).optional(),
        totalCnt: z.union([z.number(), z.string()]).optional(),
        itemList: z.array(z.record(z.string(), z.unknown())).optional()
    })
        .passthrough()
})
    .passthrough();
const singleOutput = (key, itemKey) => z
    .object({
    [key]: z.object({ [itemKey]: z.record(z.string(), z.unknown()).optional() }).passthrough()
})
    .passthrough();
export const TOOL_DEFS = [
    {
        name: 'get_daily_boxoffice',
        title: '일별 박스오피스 조회',
        description: '특정 일자(YYYYMMDD)의 박스오피스 순위, 관객수, 매출액 등 순수 API 결과를 조회합니다.',
        endpoint: '/boxoffice/searchDailyBoxOfficeList.json',
        inputSchema: strictObj({
            targetDt: targetDt.describe('조회 일자 (YYYYMMDD 형식, 예: 20260902)'),
            itemPerPage: z.string().optional().describe('조회 건수 (기본값 10)'),
            multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부 (Y: 다양성, N: 상업영화)'),
            repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분 (K: 한국, F: 외국)'),
            wideAreaCd: z.string().optional().describe('지역코드 (예: 0105001 서울, 0105002 경기 등. get_code_list로 확인)')
        }),
        outputSchema: listOutput('boxOfficeResult', 'dailyBoxOffice')
    },
    {
        name: 'get_weekly_boxoffice',
        title: '주간/주말 박스오피스 조회',
        description: '특정 주(일요일 YYYYMMDD)의 주말(금-일) 또는 주간 박스오피스 순수 API 결과를 조회합니다.',
        endpoint: '/boxoffice/searchWeeklyBoxOfficeList.json',
        inputSchema: strictObj({
            targetDt: targetDt.describe('해당 주의 일요일 일자 (YYYYMMDD 형식, 예: 20260830)'),
            weekGb: z.enum(['0', '1', '2']).optional().describe('0: 주간(월-일), 1: 주말(금-일), 2: 주중(월-목)'),
            itemPerPage: z.string().optional().describe('조회 건수 (기본값 10)'),
            multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부 (Y: 다양성, N: 상업영화)'),
            repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분 (K: 한국, F: 외국)'),
            wideAreaCd: z.string().optional().describe('지역코드 (예: 0105001 서울, 0105002 경기 등)')
        }),
        outputSchema: listOutput('boxOfficeResult', 'weeklyBoxOffice')
    },
    {
        name: 'search_movie_list',
        title: '영화 목록 검색',
        description: '영화 제목, 감독명, 제작연도, 개봉연도 키워드로 영화 목록 순수 API 결과를 검색합니다.',
        endpoint: '/movie/searchMovieList.json',
        inputSchema: strictObj({
            movieNm: z.string().optional().describe('영화 제목 (키워드 검색)'),
            directorNm: z.string().optional().describe('감독명'),
            openStartDt: z.string().optional().describe('개봉연도 시작 (YYYY 형식)'),
            openEndDt: z.string().optional().describe('개봉연도 끝 (YYYY 형식)'),
            prdtStartYear: z.string().optional().describe('제작연도 시작 (YYYY)'),
            prdtEndYear: z.string().optional().describe('제작연도 끝 (YYYY)'),
            repNationCd: z.string().optional().describe('국적코드 (K: 한국, F: 외국 또는 공통코드 2204 국적코드)'),
            movieTypeCd: z.string().optional().describe('영화형태 (예: 장편, 단편 등)'),
            ...pageSchema
        }),
        outputSchema: listOutput('movieListResult', 'movieList')
    },
    {
        name: 'get_movie_detail',
        title: '영화 상세정보 조회',
        description: '영화코드(movieCd)로 상영시간, 관람등급, 장르, 감독, 배우, 배급사, 제작사 등 순수 API 상세 정보를 조회합니다.',
        endpoint: '/movie/searchMovieInfo.json',
        inputSchema: strictObj({
            movieCd: z.string().describe('영화코드 (8자리 영진위 고유 코드, search_movie_list로 확인)')
        }),
        outputSchema: singleOutput('movieInfoResult', 'movieInfo')
    },
    {
        name: 'search_company_list',
        title: '영화사 목록 검색',
        description: '영화사 이름이나 대표자명으로 영화사 목록 순수 API 결과를 검색합니다.',
        endpoint: '/company/searchCompanyList.json',
        inputSchema: strictObj({
            companyNm: z.string().optional().describe('영화사명 키워드'),
            ceoNm: z.string().optional().describe('대표자명'),
            companyPartCd: z.string().optional().describe('분류코드 (제작사, 배급사 등. get_code_list로 확인)'),
            ...pageSchema
        }),
        outputSchema: listOutput('companyListResult', 'companyList')
    },
    {
        name: 'get_company_detail',
        title: '영화사 상세정보 조회',
        description: '영화사코드(companyCd)로 영화사의 대표자명, 업종, 전체 필모그래피 순수 API 상세 정보를 조회합니다.',
        endpoint: '/company/searchCompanyInfo.json',
        inputSchema: strictObj({
            companyCd: z.string().describe('영화사코드 (8자리 코드, search_company_list로 확인)')
        }),
        outputSchema: singleOutput('companyInfoResult', 'companyInfo')
    },
    {
        name: 'search_people_list',
        title: '영화인 목록 검색',
        description: '영화인 이름 또는 참여 영화명으로 영화인 목록 순수 API 결과를 검색합니다.',
        endpoint: '/people/searchPeopleList.json',
        inputSchema: strictObj({
            peopleNm: z.string().optional().describe('영화인 이름 (배우, 감독, 스태프 등)'),
            filmoNames: z.string().optional().describe('출연 또는 제작 참여 영화명'),
            ...pageSchema
        }),
        outputSchema: listOutput('peopleListResult', 'peopleList')
    },
    {
        name: 'get_people_detail',
        title: '영화인 상세정보 조회',
        description: '영화인코드(peopleCd)로 해당 인물의 분야, 전체 필모그래피 순수 API 상세 정보를 조회합니다.',
        endpoint: '/people/searchPeopleInfo.json',
        inputSchema: strictObj({
            peopleCd: z.string().describe('영화인코드 (8자리 코드, search_people_list로 확인)')
        }),
        outputSchema: singleOutput('peopleInfoResult', 'peopleInfo')
    },
    {
        name: 'get_code_list',
        title: '공통코드 조회',
        description: '영진위 오픈API 공통 코드(지역코드: 0105000000, 영화구분: 220101, 영화유형: 220201 등) 순수 API 결과를 조회합니다.',
        endpoint: '/code/searchCodeList.json',
        inputSchema: strictObj({
            comCode: z.string().describe('조회할 상위 코드값 (지역코드: 0105000000, 영화구분: 220101, 영화유형: 220201 등)')
        }),
        outputSchema: listOutput('codeListResult', 'code')
    }
];
// ---------------------------------------------------------------------------
// 서버 팩토리 (stateless-safe: 요청/연결마다 새 서버를 만들어도 안전)
// ---------------------------------------------------------------------------
export function createServer() {
    const server = new McpServer({ name: 'kobis-mcp', version: '2.0.0' });
    const limiter = createRateLimiter();
    for (const def of TOOL_DEFS) {
        server.registerTool(def.name, {
            title: def.title,
            description: def.description,
            inputSchema: def.inputSchema,
            outputSchema: def.outputSchema,
            annotations: { readOnlyHint: true, openWorldHint: true }
        }, makeToolHandler(def.endpoint, limiter));
    }
    return server;
}
// Stdio 연결: CLI로 직접 실행된 경우에만 연결.
// v2/2026-07-28 방식: serveStdio(factory) — 접속 첫 교환에서 에라(era)를 협상하여
// 2026-07-28 모던 클라이언트(server/discover + per-request _meta envelope)와
// 2025-era 레거시 클라이언트(initialize 핸드셰이크)를 같은 팩토리로 서빙한다.
// (v1의 `server.connect(new StdioServerTransport())` 대체 — 공식 마이그레이션 경로)
const isDirectRun = process.argv[1]
    ? path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
    : false;
if (isDirectRun && process.env.NODE_ENV !== 'test') {
    const handle = serveStdio(() => createServer());
    // stdout은 JSON-RPC 채널 — 진단 로그는 반드시 stderr로만 출력
    console.error('kobis-mcp v2 (protocol 2026-07-28 / legacy-compatible) listening on stdio');
    process.on('SIGINT', () => {
        void handle.close();
    });
}
