# kobis-mcp (Unofficial)

[![CI](https://github.com/minking/kobis-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/minking/kobis-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

영화진흥위원회(KOBIS) 영화관입장권통합전산망 오픈API를 연동하는 비공식 MCP(Model Context Protocol) 서버입니다.

> 안내: 본 프로젝트는 개인이 오픈API를 활용하기 위해 만든 비공식 도구이며, 데이터의 권리는 영화진흥위원회에 있습니다.

---

## 주요 특징

- **보안 통신 (HTTPS)**: 영진위 오픈API와 전 구간 HTTPS 통신을 수행하여 API 키 및 전송 데이터를 안전하게 보호합니다.
- **내장 Rate Limiter**: 영진위 API 정책에 맞춰 동시 요청 및 연속 호출 시 최소 250ms 간격을 자동으로 조절하여 안정적인 조회를 보장합니다.
- **Zero-Dependency 검증**: 가볍고 빠른 내장 런타임을 유지하며, Node.js 기본 내장 테스트 러너(`node:test`)로 100% 검증됩니다.

---

## 제공 API 목록

| 기능 (Tool) | 설명 | 파라미터 |
|---|---|---|
| `get_daily_boxoffice` | 일별 박스오피스 TOP 10 및 관객수/매출액 조회 | `targetDt` (YYYYMMDD), `multiMovieYn`, `repNationCd`, `wideAreaCd` |
| `get_weekly_boxoffice` | 주말(금-일) 또는 주간(월-일) 박스오피스 조회 | `targetDt` (일요일 YYYYMMDD), `weekGb` (0:주간, 1:주말, 2:주중) |
| `search_movie_list` | 영화명, 감독명 등으로 영화 목록 검색 | `movieNm`, `directorNm`, `openStartYear`, `openEndYear` |
| `get_movie_detail` | 영화 상세 정보 조회 (상영시간, 관람등급, 감독, 배우, 배급사) | `movieCd` |
| `search_company_list` | 영화사(배급사/제작사) 검색 | `companyNm`, `ceoNm`, `companyPartCd` |
| `get_company_detail` | 영화사 상세 정보 및 필모그래피 조회 | `companyCd` |
| `search_people_list` | 영화인(배우/감독) 검색 | `peopleNm`, `filmoNames` |
| `get_people_detail` | 영화인 상세 정보 및 필모그래피 조회 | `peopleCd` |
| `get_code_list` | 영진위 공통코드(지역코드 등) 조회 | `comCode` (기본값: 0105000000) |

---

## 호출 제한 및 정책

- **호출 간격 및 순차 동기화**: 내부 Sequential Sync Queue가 적용되어 있어 다중/동시 요청 시에도 이전 응답을 확인한 후 최소 250ms 간격을 두고 안전하게 순차 처리합니다.
- **일일 한도**: 영진위 오픈API 무료 정책에 따라 1일 3,000회 제한이 적용됩니다.

---

## 설정 예시

### Claude Desktop / Cursor / Antigravity

안정적인 실행을 위해 특정 태그(예: `#v1.0.0`)를 지정하여 실행하는 것을 권장합니다.

```json
{
  "mcpServers": {
    "kobis-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/kobis-mcp#v1.0.0"],
      "env": {
        "KOBIS_API_KEY": "영진위_API_키"
      }
    }
  }
}
```

> 최신 `main` 브랜치를 직접 실행하려면 `#v1.0.0` 태그를 생략하고 `"github:minking/kobis-mcp"`로 지정할 수 있습니다.

---

## 라이선스

[MIT License](LICENSE) © 2026 minking
