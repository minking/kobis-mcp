# kobis-mcp (Unofficial)

영화진흥위원회(KOBIS) 영화관입장권통합전산망 오픈API를 연동하는 **비공식(Unofficial) Model Context Protocol (MCP) 서버**입니다.  
AI 에이전트(Antigravity, Claude Desktop, Cursor 등)에서 실시간 일별/주간 박스오피스, 영화 정보, 제작/배급사, 배우/감독 필모그래피, 공통코드를 자연어로 손쉽게 조회할 수 있습니다.

> ⚠️ **안내 (Disclaimer)**:  
> 본 프로젝트는 영화진흥위원회(KOFIC)가 공식적으로 제작·배포한 것이 아니며, 개인이 공공 오픈API를 편리하게 활용하기 위해 개발한 **비공식(Unofficial) 도구**입니다. 제공되는 모든 영화 및 박스오피스 데이터의 원천과 권리는 영화진흥위원회 영화관입장권통합전산망(KOBIS)에 있습니다.

---

## 🛡️ 영진위 오픈API 규약 준수 및 4중 보호 시스템

영진위 오픈API의 이용 규약 준수와 사용자 API 키 보호를 위해 **4중 안전 방어 시스템**이 내장되어 있습니다:

1. **초당 호출 빈도 제한 (Rate Throttling)**:
   * 연속 호출 간 **최소 250ms 딜레이를 강제 보장(초당 최대 4회)**합니다.
   * AI가 대량의 데이터를 수집하기 위해 연속 호출을 시도해도, 영진위 방화벽(WAF)에서 디도스(DDoS)나 비정상 스크래핑으로 감지되어 **IP가 차단되는 사고를 원천 방지**합니다.
2. **429/503 지수 백오프 자동 재시도 (Exponential Backoff)**:
   * 일시적 트래픽 급증으로 `HTTP 429(Too Many Requests)` 또는 `503`이 발생할 경우, 1초/2초 대기 후 **최대 2회 자동 안전 재시도**를 수행합니다.
3. **스마트 로컬 디스크 캐싱 (`~/.kobis-cache`)**:
   * 이미 확정된 과거 날짜의 박스오피스나 영화 정보는 최초 1회만 조회 후 로컬에 영구 캐싱됩니다.
   * 동일한 날짜를 반복 조회할 경우 **API 호출을 0회 소모(0ms 즉각 반환)**하므로 1일 3,000회 한도를 획기적으로 아낍니다.
4. **일일 3,000회 서킷브레이커 (Circuit Breaker)**:
   * 당일 자정(00:00) 기준으로 호출 횟수를 실시간 카운트하며, 안전 임계치(2,950회)에 도달하면 추가 요청을 자동 차단하여 **API 키가 정지되는 사태를 물리적으로 차단**합니다.
5. **실시간 사용량 조회 (`get_quota_status`)**:
   * 대화창에서 언제든 "오늘 영진위 API 몇 번 썼어?"라고 물어보면 실시간 호출 횟수와 잔여 한도를 확인할 수 있습니다.

---

## 🛠️ 제공 도구 목록 (10종)

| 도구명 | 설명 | 주요 파라미터 |
|---|---|---|
| **`get_daily_boxoffice`** | 특정 일자 일별 박스오피스 TOP 10 및 관객수/매출액 조회 *(과거 일자 자동 캐싱)* | `targetDt` (YYYYMMDD), `multiMovieYn`, `repNationCd`, `wideAreaCd` |
| **`get_weekly_boxoffice`** | 주말(금-일) 또는 주간(월-일) 박스오피스 순위 및 관객수 조회 *(자동 캐싱)* | `targetDt` (일요일 YYYYMMDD), `weekGb` (0:주간, 1:주말, 2:주중) |
| **`search_movie_list`** | 영화 제목, 감독명, 개봉/제작연도 키워드로 영화 목록 검색 | `movieNm`, `directorNm`, `openStartYear`, `openEndYear` |
| **`get_movie_detail`** | 영화 코드로 상영시간, 관람등급, 감독, 출연진, 배급사 상세 조회 | `movieCd` (영진위 8자리 고유코드) |
| **`search_company_list`** | 영화사(배급사, 제작사, 상영업)명 또는 대표자명 검색 | `companyNm`, `ceoNm`, `companyPartCd` |
| **`get_company_detail`** | 영화사 코드로 대표자, 참여업종, 전체 필모그래피 목록 조회 | `companyCd` |
| **`search_people_list`** | 영화인(배우, 감독, 스태프)명 또는 참여 영화명으로 검색 | `peopleNm`, `filmoNames` |
| **`get_people_detail`** | 영화인 코드로 대표분야 및 전체 필모그래피 전수 목록 조회 | `peopleCd` |
| **`get_code_list`** | 영진위 공통코드(전국 17개 시/도 지역코드 등) 조회 | `comCode` (기본값: `0105000000`) |
| **`get_quota_status`** | 오늘 사용한 API 호출 횟수, 잔여 호출 한도 및 로컬 캐시 상태 조회 | *(파라미터 없음)* |

---

## ⚙️ MCP 클라이언트 설정 (mcp_config.json)

설정 파일에 아래 설정을 추가하여 즉시 사용합니다:

```json
{
  "mcpServers": {
    "kobis-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/kobis-mcp"],
      "env": {
        "KOBIS_API_KEY": "영진위_발급_API키_입력"
      }
    }
  }
}
```
