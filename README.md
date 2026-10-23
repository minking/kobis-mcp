# kobis-mcp (Unofficial)

[![CI](https://github.com/minking/kobis-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/minking/kobis-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

영화진흥위원회(KOBIS) 영화관입장권통합전산망 오픈API를 연동하는 비공식 MCP(Model Context Protocol) 서버입니다.

---

## 주요 특징

- **최신 MCP 스펙(2026-07-28) & 공식 SDK v2 대응**: 대대적인 무상태(stateless) 개편을 거친 정식 표준 프로토콜 리비전 **2026-07-28**과 공식 1티어 TypeScript SDK **v2**(`@modelcontextprotocol/server` 2.x, Zod ≥4.2) 기준으로 구현되었습니다. (최초 공개 버전 2024-11-05 → 2025-era → 2026-07-28 무상태 표준으로 진화)
  - `serveStdio(factory)` 연결 고정(entrypoint) — 접속 첫 교환에서 에라(era)를 협상: **2026-07-28 모던 클라이언트**는 `server/discover` + per-request `_meta` envelope(SEP-2243), **2025-era 레거시 클라이언트**(Claude Desktop/Cursor 등)는 기존 `initialize` 핸드셰이크로 동일 팩토리 서빙
  - v1 `@modelcontextprotocol/sdk` 제거, v2 패키지 구조(`@modelcontextprotocol/server`, 스키마는 `@modelcontextprotocol/core`)로 마이그레이션
  - `McpError` → `ProtocolError` (v2 3계층 에러 체계: ProtocolError / SdkError / SdkHttpError)
  - `registerTool()` 설정 객체 API + 도구별 `title`, `annotations`(readOnlyHint/openWorldHint)
  - `outputSchema` + `structuredContent` 라운드트립 검증 (Strict Tools), 입력 `.strict()` — 미지 파라미터 거부
- **Stateless-first 아키텍처**: 2026-07-28의 요청 단위(per-request, 세션 ID 폐지) 모델에 맞춰, 도구 핸들러가 initialize/세션 상태에 전혀 의존하지 않는 순수 함수입니다. Rate limiter 큐가 서버 팩토리(`createServer()`) 내부 클로저로 캡슐화되어 있어 `createMcpHandler`(HTTP per-request) 배포 시에도 안전합니다. 필요 시 `@modelcontextprotocol/server`의 `createMcpHandler(() => createServer())`로 HTTP 엔드포인트를 추가할 수 있습니다.
- **순수 API Passthrough**: 영진위 응답 데이터를 임의 가공·필터링하지 않고 원본 필드 그대로 반환합니다.
- **내장 Rate Limiter & Queue**: 동시·연속 요청 시 직전 응답 완료 후 최소 250ms 간격을 보장하여 안정적으로 호출합니다.
- **Node 내장 fetch**: 외부 폴리필 없이 Node 20+ 내장 `fetch`/`AbortSignal.timeout`을 사용합니다.
- **Zero-Dependency 검증**: 외부 테스트 프레임워크 없이 Node.js 내장 테스트 러너(`node:test`)로 검증됩니다.

---

## 제공 도구 (Tools)

| 도구명 | 설명 | 파라미터 |
|---|---|---|
| `get_daily_boxoffice` | 일별 박스오피스 순위 및 관객수/매출액 조회 | `targetDt` (필수, YYYYMMDD), `itemPerPage`, `multiMovieYn`, `repNationCd`, `wideAreaCd` |
| `get_weekly_boxoffice` | 주간/주말/주중 박스오피스 조회 | `targetDt` (필수, 일요일 YYYYMMDD), `weekGb` (0:주간, 1:주말, 2:주중), `itemPerPage`, `multiMovieYn`, `repNationCd`, `wideAreaCd` |
| `search_movie_list` | 영화 목록 검색 | `movieNm`, `directorNm`, `openStartDt`, `openEndDt`, `prdtStartYear`, `prdtEndYear`, `repNationCd`, `movieTypeCd`, `curPage`, `itemPerPage` |
| `get_movie_detail` | 영화 상세정보 조회 | `movieCd` (필수) |
| `search_company_list` | 영화사(제작/배급 등) 목록 검색 | `companyNm`, `ceoNm`, `companyPartCd`, `curPage`, `itemPerPage` |
| `get_company_detail` | 영화사 상세정보 및 필모그래피 조회 | `companyCd` (필수) |
| `search_people_list` | 영화인(배우/감독 등) 목록 검색 | `peopleNm`, `filmoNames`, `curPage`, `itemPerPage` |
| `get_people_detail` | 영화인 상세정보 및 필모그래피 조회 | `peopleCd` (필수) |
| `get_code_list` | 영진위 공통코드(지역, 영화유형 등) 조회 | `comCode` (필수) |

---

## 설정 예시

### Claude Desktop / Cursor / Antigravity

```json
{
  "mcpServers": {
    "kobis-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/kobis-mcp"],
      "env": {
        "KOBIS_API_KEY": "영진위_API_키"
      }
    }
  }
}
```

### 라이브러리 사용 (Stateless HTTP 배포 등)

```ts
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from 'kobis-mcp';

// 2026-07-28: 요청마다 새 서버 인스턴스를 만들어 서빙하는 stateless 팩토리
const handler = createMcpHandler(() => createServer());
// Web 표준 런타임: export default handler;
// Node 프레임워크: app.all('/mcp', toNodeHandler(handler)) (@modelcontextprotocol/node)
```

---

## 호출 제한 및 라이선스

- **일일 한도**: 영진위 오픈API 무료 정책상 일 3,000회 제한
- **라이선스**: [MIT License](LICENSE) © 2026 minking
