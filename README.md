# kobis-mcp (Unofficial)

영화진흥위원회(KOBIS) 영화관입장권통합전산망 오픈API를 연동하는 **비공식(Unofficial) Model Context Protocol (MCP) 서버**입니다.  
AI 에이전트(Antigravity, Claude Desktop, Cursor 등)에서 실시간 일별/주간 박스오피스, 영화 정보, 제작/배급사, 배우/감독 필모그래피, 공통코드를 자연어로 손쉽게 조회할 수 있습니다.

> ⚠️ **안내 (Disclaimer)**:  
> 본 프로젝트는 영화진흥위원회(KOFIC)가 공식적으로 제작·배포한 것이 아니며, 개인이 공공 오픈API를 편리하게 활용하기 위해 개발한 **비공식(Unofficial) 도구**입니다. 제공되는 모든 영화 및 박스오피스 데이터의 원천과 권리는 영화진흥위원회 영화관입장권통합전산망(KOBIS)에 있습니다.

---

## 🛡️ 일일 3,000회 제한 방어 & 스마트 캐시 (Rate Limiting & Cache)

영진위 오픈API의 **일일 3,000회 호출 한도**를 보호하기 위해 지능형 방어 시스템이 탑재되어 있습니다:

1. **스마트 로컬 캐싱 (`~/.kobis-cache`)**:
   * 이미 확정된 과거 날짜의 박스오피스나 영화 정보는 최초 1회만 조회 후 로컬에 영구 캐싱됩니다.
   * 동일한 날짜를 반복 조회할 경우 **API 호출을 0회 소모(0ms 즉각 반환)**하므로 할당량이 낭비되지 않습니다.
2. **일일 호출 안전 차단기 (Circuit Breaker)**:
   * 당일 자정(00:00) 기준으로 호출 횟수를 실시간 카운트하며, 안전 임계치(2,950회)에 도달하면 무차별 요청을 자동 차단하여 **API 키가 영진위로부터 정지되는 사고를 원천 방지**합니다.
3. **실시간 사용량 조회 (`get_quota_status`)**:
   * 언제든 "오늘 API 몇 번 썼어?"라고 질문하면 실시간 호출 횟수와 잔여 한도를 확인할 수 있습니다.

---

## 🛠️ 제공 도구 목록 (10종)

| 도구명 | 설명 | 주요 파라미터 |
|---|---|---|
| **`get_daily_boxoffice`** | 특정 일자 일별 박스오피스 TOP 10 및 관객수/매출액 조회 *(과거 일자 자동 캐싱)* | `targetDt` (YYYYMMDD), `multiMovieYn`, `repNationCd`, `wideAreaCd` |
| **`get_weekly_boxoffice`** | 주말(금~일) 또는 주간(월~일) 박스오피스 순위 및 관객수 조회 *(자동 캐싱)* | `targetDt` (일요일 YYYYMMDD), `weekGb` (0:주간, 1:주말, 2:주중) |
| **`search_movie_list`** | 영화 제목, 감독명, 개봉/제작연도 키워드로 영화 목록 검색 | `movieNm`, `directorNm`, `openStartYear`, `openEndYear` |
| **`get_movie_detail`** | 영화 코드로 상영시간, 관람등급, 감독, 출연진, 배급사 상세 조회 | `movieCd` (영진위 8자리 고유코드) |
| **`search_company_list`** | 영화사(배급사, 제작사, 상영업)명 또는 대표자명 검색 | `companyNm`, `ceoNm`, `companyPartCd` |
| **`get_company_detail`** | 영화사 코드로 대표자, 참여업종, 전체 필모그래피 목록 조회 | `companyCd` |
| **`search_people_list`** | 영화인(배우, 감독, 스태프)명 또는 참여 영화명으로 검색 | `peopleNm`, `filmoNames` |
| **`get_people_detail`** | 영화인 코드로 대표분야 및 전체 필모그래피 전수 목록 조회 | `peopleCd` |
| **`get_code_list`** | 영진위 공통코드(전국 17개 시/도 지역코드 등) 조회 | `comCode` (기본값: `0105000000`) |
| **`get_quota_status`** | 오늘 사용한 API 호출 횟수, 잔여 호출 한도 및 로컬 캐시 상태 조회 | *(파라미터 없음)* |

---

## ⚙️ 설정 및 실행 방법

### 1. 환경변수 설정
영진위 오픈API 포털(kobis.or.kr)에서 무료 발급받은 API 키를 `.env` 파일에 설정합니다:
```env
KOBIS_API_KEY=your_kobis_api_key_here
```

### 2. MCP 클라이언트 설정 (`mcp_config.json`)

#### 로컬 실행 시:
```json
{
  "mcpServers": {
    "kobis-mcp": {
      "command": "node",
      "args": ["C:/Users/choyc/.workspace/kobis-mcp/index.js"],
      "env": {
        "KOBIS_API_KEY": "발급받은_키_입력"
      }
    }
  }
}
```

#### 깃허브 배포 후 npx 원클릭 실행 시:
```json
{
  "mcpServers": {
    "kobis-mcp": {
      "command": "npx",
      "args": ["-y", "github:minking/kobis-mcp"],
      "env": {
        "KOBIS_API_KEY": "발급받은_키_입력"
      }
    }
  }
}
```

---

## 💬 사용 예시

* *"어제 박스오피스 1~5위 관객수와 점유율 알려줘"*
* *"오늘 영진위 API 몇 번 썼는지 사용량 확인해줘"*
* *"영화 '오디세이' 상세 정보와 배급사 확인해줘"*
* *"CJ CGV 영화사의 대표자랑 최근 배급/제작한 영화 목록 찾아줘"*
* *"봉준호 감독의 전체 필모그래피 목록 보여줘"*
