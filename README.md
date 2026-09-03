# kobis-mcp (Unofficial)

영화진흥위원회(KOBIS) 영화관입장권통합전산망 오픈API를 연동하는 비공식 MCP(Model Context Protocol) 서버입니다.

> 안내: 본 프로젝트는 개인이 오픈API를 활용하기 위해 만든 비공식 도구이며, 데이터의 권리는 영화진흥위원회에 있습니다.

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
| `get_quota_status` | 오늘 API 호출 횟수 및 남은 한도 확인 | 없음 |

---

## API 호출 제한 및 캐시

- **일일 호출 제한**: 영진위 API 정책에 따라 1일 3,000회로 제한되며, 2,950회 도달 시 자동 차단됩니다.
- **호출 간격**: 연속 요청 시 최소 250ms 간격을 두고 호출합니다.
- **로컬 캐시**: 과거 일자 박스오피스 및 상세 정보는 로컬(`~/.kobis-cache`)에 캐시되어 중복 호출 시 API를 소모하지 않습니다.

---

## 설정 방법 (mcp_config.json)

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
