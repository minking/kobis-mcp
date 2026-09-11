#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'kobis-mcp', version: '1.0.1' });
const BASE_URL = 'https://www.kobis.or.kr/kobisopenapi/webservice/rest';

// 순차 동기화 대기 큐 (응답 완료 확인 + 최소 250ms 간격 보장)
let queue: Promise<any> = Promise.resolve();
let lastCompletedTime = 0;
export const RATE_LIMIT_MS = 250;

export function enqueue<T>(task: () => Promise<T>, intervalMs = RATE_LIMIT_MS): Promise<T> {
  const next = queue.then(async () => {
    const elapsed = Date.now() - lastCompletedTime;
    if (elapsed < intervalMs) {
      await new Promise((r) => setTimeout(r, intervalMs - elapsed));
    }
    try {
      return await task();
    } finally {
      lastCompletedTime = Date.now();
    }
  });
  queue = next.catch(() => {});
  return next;
}

export const pageSchema = {
  curPage: z.string().regex(/^\d+$/, '숫자만 입력 가능합니다').optional().describe('페이지 번호 (기본 1)'),
  itemPerPage: z.string().regex(/^\d+$/, '숫자만 입력 가능합니다').optional().describe('페이지당 건수 (기본 10)')
};

async function fetchKobis(endpoint: string, params: Record<string, any>): Promise<any> {
  const key = process.env.KOBIS_API_KEY;
  if (!key) throw new Error('KOBIS_API_KEY 환경변수가 설정되지 않았습니다.');

  return enqueue(async () => {
    const searchParams = new URLSearchParams({ key });
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') searchParams.set(k, String(v));
    }

    const res = await fetch(`${BASE_URL}${endpoint}?${searchParams}`, {
      headers: { 'User-Agent': 'kobis-mcp/1.0.1' },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      throw new Error(`KOBIS HTTP 오류: ${res.status} ${res.statusText}`);
    }

    const data: any = await res.json();
    if (data?.faultInfo) {
      throw new Error(`[KOBIS ${data.faultInfo.errorCode || 'ERROR'}] ${data.faultInfo.message}`);
    }
    return data;
  });
}

export function toolHandler<T>(fn: (args: T) => Promise<any>) {
  return async (args: T) => {
    try {
      const res = await fn(args);
      return { content: [{ type: 'text' as const, text: typeof res === 'string' ? res : JSON.stringify(res, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `오류: ${err.message || err}` }], isError: true };
    }
  };
}

export const targetDtSchema = z.string().regex(/^\d{8}$/, 'YYYYMMDD 형식(8자리 숫자)이어야 합니다');

// 1. 일별 박스오피스
server.tool(
  'get_daily_boxoffice',
  '특정 일자(YYYYMMDD)의 박스오피스 순위, 관객수, 매출액 등 순수 API 결과를 조회합니다.',
  {
    targetDt: targetDtSchema.describe('조회 일자 (YYYYMMDD 형식, 예: 20260902)'),
    itemPerPage: z.string().optional().describe('조회 건수 (기본값 10)'),
    multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부 (Y: 다양성, N: 상업영화)'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분 (K: 한국, F: 외국)'),
    wideAreaCd: z.string().optional().describe('지역코드 (예: 0105001 서울, 0105002 경기 등. get_code_list로 확인)')
  },
  toolHandler((params) => fetchKobis('/boxoffice/searchDailyBoxOfficeList.json', params))
);

// 2. 주간/주말 박스오피스
server.tool(
  'get_weekly_boxoffice',
  '특정 주(일요일 YYYYMMDD)의 주말(금-일) 또는 주간 박스오피스 순수 API 결과를 조회합니다.',
  {
    targetDt: targetDtSchema.describe('해당 주의 일요일 일자 (YYYYMMDD 형식, 예: 20260830)'),
    weekGb: z.enum(['0', '1', '2']).optional().describe('0: 주간(월-일), 1: 주말(금-일), 2: 주중(월-목)'),
    itemPerPage: z.string().optional().describe('조회 건수 (기본값 10)'),
    multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부 (Y: 다양성, N: 상업영화)'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분 (K: 한국, F: 외국)'),
    wideAreaCd: z.string().optional().describe('지역코드 (예: 0105001 서울, 0105002 경기 등)')
  },
  toolHandler((params) => fetchKobis('/boxoffice/searchWeeklyBoxOfficeList.json', params))
);

// 3. 영화 목록 검색
server.tool(
  'search_movie_list',
  '영화 제목, 감독명, 제작연도, 개봉연도 키워드로 영화 목록 순수 API 결과를 검색합니다.',
  {
    movieNm: z.string().optional().describe('영화 제목 (키워드 검색)'),
    directorNm: z.string().optional().describe('감독명'),
    openStartDt: z.string().optional().describe('개봉연도 시작 (YYYY 형식)'),
    openEndDt: z.string().optional().describe('개봉연도 끝 (YYYY 형식)'),
    prdtStartYear: z.string().optional().describe('제작연도 시작 (YYYY)'),
    prdtEndYear: z.string().optional().describe('제작연도 끝 (YYYY)'),
    repNationCd: z.string().optional().describe('국적코드 (K: 한국, F: 외국 또는 공통코드 2204 국적코드)'),
    movieTypeCd: z.string().optional().describe('영화형태 (예: 장편, 단편 등)'),
    ...pageSchema
  },
  toolHandler((params) => fetchKobis('/movie/searchMovieList.json', params))
);

// 4. 영화 상세 정보 조회
server.tool(
  'get_movie_detail',
  '영화코드(movieCd)로 상영시간, 관람등급, 장르, 감독, 배우, 배급사, 제작사 등 순수 API 상세 정보를 조회합니다.',
  { movieCd: z.string().describe('영화코드 (8자리 영진위 고유 코드, search_movie_list로 확인)') },
  toolHandler((params) => fetchKobis('/movie/searchMovieInfo.json', params))
);

// 5. 영화사 목록 검색
server.tool(
  'search_company_list',
  '영화사 이름이나 대표자명으로 영화사 목록 순수 API 결과를 검색합니다.',
  {
    companyNm: z.string().optional().describe('영화사명 키워드'),
    ceoNm: z.string().optional().describe('대표자명'),
    companyPartCd: z.string().optional().describe('분류코드 (제작사, 배급사 등. get_code_list로 확인)'),
    ...pageSchema
  },
  toolHandler((params) => fetchKobis('/company/searchCompanyList.json', params))
);

// 6. 영화사 상세 정보 조회
server.tool(
  'get_company_detail',
  '영화사코드(companyCd)로 영화사의 대표자명, 업종, 전체 필모그래피 순수 API 상세 정보를 조회합니다.',
  { companyCd: z.string().describe('영화사코드 (8자리 코드, search_company_list로 확인)') },
  toolHandler((params) => fetchKobis('/company/searchCompanyInfo.json', params))
);

// 7. 영화인 목록 검색
server.tool(
  'search_people_list',
  '영화인 이름 또는 참여 영화명으로 영화인 목록 순수 API 결과를 검색합니다.',
  {
    peopleNm: z.string().optional().describe('영화인 이름 (배우, 감독, 스태프 등)'),
    filmoNames: z.string().optional().describe('출연 또는 제작 참여 영화명'),
    ...pageSchema
  },
  toolHandler((params) => fetchKobis('/people/searchPeopleList.json', params))
);

// 8. 영화인 상세 정보 조회
server.tool(
  'get_people_detail',
  '영화인코드(peopleCd)로 해당 인물의 분야, 전체 필모그래피 순수 API 상세 정보를 조회합니다.',
  { peopleCd: z.string().describe('영화인코드 (8자리 코드, search_people_list로 확인)') },
  toolHandler((params) => fetchKobis('/people/searchPeopleInfo.json', params))
);

// 9. 공통코드 조회
server.tool(
  'get_code_list',
  '영진위 오픈API 공통 코드(지역코드: 0105000000, 영화구분: 220101, 영화유형: 220201 등) 순수 API 결과를 조회합니다.',
  { comCode: z.string().describe('조회할 상위 코드값 (지역코드: 0105000000, 영화구분: 220101, 영화유형: 220201 등)') },
  toolHandler((params) => fetchKobis('/code/searchCodeList.json', params))
);

// Stdio 연결: CLI로 직접 실행된 경우에만 연결
const isDirectRun = process.argv[1]
  ? path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
  : false;

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

