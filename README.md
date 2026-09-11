# kobis-mcp (Unofficial)

[![CI](https://github.com/minking/kobis-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/minking/kobis-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

영화진흥위원회(KOBIS) 영화관입장권통합전산망 오픈API를 연동하는 비공식 MCP(Model Context Protocol) 서버입니다.

---

## 주요 특징

- **순수 API Passthrough**: 영진위 응답 데이터를 임의 가공·필터링하지 않고 원본 필드 그대로 반환합니다.
- **내장 Rate Limiter & Queue**: 동시·연속 요청 시 직전 응답 완료 후 최소 250ms 간격을 보장하여 안정적으로 호출합니다.
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

---

## 호출 제한 및 라이선스

- **일일 한도**: 영진위 오픈API 무료 정책상 일 3,000회 제한
- **라이선스**: [MIT License](LICENSE) © 2026 minking
