#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';

const server = new McpServer({
  name: 'kobis-mcp',
  version: '1.5.0',
});

const BASE_URL = 'http://www.kobis.or.kr/kobisopenapi/webservice/rest';
const MIN_INTERVAL_MS = 250; // 연속 호출 간 최소 250ms 간격 유지 (초당 최대 4회)

let lastRequestTime = 0;

async function throttleRequest(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < MIN_INTERVAL_MS) {
    const waitMs = MIN_INTERVAL_MS - timeSinceLast;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  lastRequestTime = Date.now();
}

function checkApiKey(): string {
  const key = process.env.KOBIS_API_KEY || '';
  if (!key) {
    throw new Error('KOBIS_API_KEY가 설정되지 않았습니다. .env 파일이나 mcp_config.json에 영진위 API 키를 설정해주세요.');
  }
  return key;
}

async function fetchKobis(endpoint: string, params: Record<string, any>): Promise<any> {
  const key = checkApiKey();
  const url = `${BASE_URL}${endpoint}`;
  const retries = 2;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await throttleRequest();
      const res = await axios.get(url, {
        params: { key, ...params },
        timeout: 10000,
        headers: {
          'User-Agent': 'kobis-mcp/1.5.0 (Model Context Protocol)'
        }
      });
      return res.data;
    } catch (err: any) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 503 || err.code === 'ECONNABORTED';
      if (isRetryable && attempt < retries) {
        const backoffMs = (attempt + 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('영진위 API 요청 실패');
}

// ============================================================================
// 1. 일별 박스오피스
// ============================================================================
server.tool(
  'get_daily_boxoffice',
  '특정 일자(YYYYMMDD)의 박스오피스 순위, 당일 관객수, 누적 관객수, 매출액, 점유율, 스크린수 등을 조회합니다.',
  {
    targetDt: z.string().describe('조회 일자 (YYYYMMDD 형식, 예: 20260902)'),
    itemPerPage: z.string().optional().describe('조회 건수 (기본값 10, 최대 10)'),
    multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부 (Y: 다양성, N: 상업영화)'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분 (K: 한국, F: 외국)'),
    wideAreaCd: z.string().optional().describe('지역코드 (서울: 0105001 등)')
  },
  async ({ targetDt, itemPerPage, multiMovieYn, repNationCd, wideAreaCd }) => {
    try {
      const raw = await fetchKobis('/boxoffice/searchDailyBoxOfficeList.json', {
        targetDt,
        itemPerPage: itemPerPage || '10',
        multiMovieYn,
        repNationCd,
        wideAreaCd
      });

      const data = raw?.boxOfficeResult;
      if (!data || !data.dailyBoxOfficeList) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const formatted = {
        조회구분: data.boxofficeType || '일별 박스오피스',
        조회일자: targetDt,
        목록: data.dailyBoxOfficeList.map((m: any) => ({
          순위: Number(m.rank),
          순위변동: m.rankInten > 0 ? `▲${m.rankInten}` : (m.rankInten < 0 ? `▼${Math.abs(m.rankInten)}` : '-'),
          신규진입: m.rankOldAndNew === 'NEW' ? 'NEW' : '',
          영화명: m.movieNm,
          영화코드: m.movieCd,
          개봉일: m.openDt,
          당일관객수: Number(m.audiCnt).toLocaleString() + '명',
          전일대비관객증감: Number(m.audiInten).toLocaleString() + '명 (' + m.audiChange + '%)',
          누적관객수: Number(m.audiAcc).toLocaleString() + '명',
          당일매출액: Number(m.salesAmt).toLocaleString() + '원',
          매출점유율: m.salesShare + '%',
          누적매출액: Number(m.salesAcc).toLocaleString() + '원',
          스크린수: Number(m.scrnCnt).toLocaleString() + '개',
          상영횟수: Number(m.showCnt).toLocaleString() + '회'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 2. 주간/주말 박스오피스
// ============================================================================
server.tool(
  'get_weekly_boxoffice',
  '특정 주(해당 주의 일요일 YYYYMMDD)의 주말(금-일) 또는 주간 박스오피스 순위, 관객수 및 매출액을 조회합니다.',
  {
    targetDt: z.string().describe('해당 주의 일요일 일자 (YYYYMMDD 형식, 예: 20260830)'),
    weekGb: z.enum(['0', '1', '2']).default('1').describe('0: 주간(월-일), 1: 주말(금-일) [기본값], 2: 주중(월-목)'),
    itemPerPage: z.string().optional().describe('조회 건수 (기본값 10)'),
    multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분'),
    wideAreaCd: z.string().optional().describe('지역코드')
  },
  async ({ targetDt, weekGb, itemPerPage, multiMovieYn, repNationCd, wideAreaCd }) => {
    try {
      const raw = await fetchKobis('/boxoffice/searchWeeklyBoxOfficeList.json', {
        targetDt,
        weekGb: weekGb || '1',
        itemPerPage: itemPerPage || '10',
        multiMovieYn,
        repNationCd,
        wideAreaCd
      });

      const data = raw?.boxOfficeResult;
      if (!data || !data.weeklyBoxOfficeList) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const formatted = {
        조회구분: data.boxofficeType || '주간/주말 박스오피스',
        조회기간: data.showRange,
        목록: data.weeklyBoxOfficeList.map((m: any) => ({
          순위: Number(m.rank),
          순위변동: m.rankInten > 0 ? `▲${m.rankInten}` : (m.rankInten < 0 ? `▼${Math.abs(m.rankInten)}` : '-'),
          신규진입: m.rankOldAndNew === 'NEW' ? 'NEW' : '',
          영화명: m.movieNm,
          영화코드: m.movieCd,
          개봉일: m.openDt,
          기간관객수: Number(m.audiCnt).toLocaleString() + '명',
          누적관객수: Number(m.audiAcc).toLocaleString() + '명',
          기간매출액: Number(m.salesAmt).toLocaleString() + '원',
          매출점유율: m.salesShare + '%',
          누적매출액: Number(m.salesAcc).toLocaleString() + '원',
          스크린수: Number(m.scrnCnt).toLocaleString() + '개'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 3. 영화 목록 검색
// ============================================================================
server.tool(
  'search_movie_list',
  '영화 제목, 감독명, 제작연도, 개봉연도 키워드로 영화 목록 및 영화코드를 검색합니다.',
  {
    movieNm: z.string().optional().describe('영화 제목 (키워드 검색)'),
    directorNm: z.string().optional().describe('감독명'),
    openStartYear: z.string().optional().describe('개봉연도 시작 (YYYY)'),
    openEndYear: z.string().optional().describe('개봉연도 끝 (YYYY)'),
    prdtStartYear: z.string().optional().describe('제작연도 시작 (YYYY)'),
    prdtEndYear: z.string().optional().describe('제작연도 끝 (YYYY)'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분'),
    movieTypeCd: z.string().optional().describe('영화형태'),
    curPage: z.string().optional().describe('페이지 번호 (기본 1)'),
    itemPerPage: z.string().optional().describe('페이지당 건수 (기본 10)')
  },
  async (params) => {
    try {
      const raw = await fetchKobis('/movie/searchMovieList.json', {
        ...params,
        curPage: params.curPage || '1',
        itemPerPage: params.itemPerPage || '10'
      });

      const data = raw?.movieListResult;
      const list = data?.movieList || [];
      const formatted = {
        총검색건수: data?.totCnt || list.length,
        목록: list.map((m: any) => ({
          영화코드: m.movieCd,
          영화명: m.movieNm,
          영문명: m.movieNmEn,
          제작연도: m.prdtYear,
          개봉일: m.openDt,
          유형: m.typeNm,
          장르: m.genreAlt,
          감독: m.directors?.map((d: any) => d.peopleNm).join(', ') || '-',
          제작사: m.companys?.map((c: any) => c.companyNm).join(', ') || '-'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 4. 영화 상세 정보 조회
// ============================================================================
server.tool(
  'get_movie_detail',
  '영화코드(movieCd)로 상영시간, 관람등급, 장르, 감독, 주요배우, 배급사, 제작사 등 상세 정보를 조회합니다.',
  {
    movieCd: z.string().describe('영화코드 (8자리 영진위 고유 코드)')
  },
  async ({ movieCd }) => {
    try {
      const raw = await fetchKobis('/movie/searchMovieInfo.json', { movieCd });
      const info = raw?.movieInfoResult?.movieInfo;
      if (!info) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const formatted = {
        영화코드: info.movieCd,
        영화명: info.movieNm,
        영문명: info.movieNmEn,
        원제: info.movieNmOg || '-',
        상영시간: info.showTm ? `${info.showTm}분` : '-',
        제작연도: info.prdtYear,
        개봉일: info.openDt,
        장르: info.genres?.map((g: any) => g.genreNm).join(', ') || '-',
        감독: info.directors?.map((d: any) => d.peopleNm).join(', ') || '-',
        주요배우: info.actors?.slice(0, 8).map((a: any) => `${a.peopleNm}(${a.cast || '배역'})`).join(', ') || '-',
        관람등급: info.audits?.map((a: any) => a.watchGradeNm).join(', ') || '-',
        배급사: info.companys?.filter((c: any) => c.companyPartNm === '배급사').map((c: any) => c.companyNm).join(', ') || '-',
        제작사: info.companys?.filter((c: any) => c.companyPartNm === '제작사').map((c: any) => c.companyNm).join(', ') || '-',
        스태프요약: info.staffs?.slice(0, 5).map((s: any) => `${s.staffRoleNm}: ${s.peopleNm}`).join(', ') || '-'
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 5. 영화사 목록 검색
// ============================================================================
server.tool(
  'search_company_list',
  '영화사 이름(companyNm)이나 대표자명으로 영화사 목록 및 고유코드를 검색합니다.',
  {
    companyNm: z.string().optional().describe('영화사명 키워드 (예: 씨제이, 롯데, 쇼박스)'),
    ceoNm: z.string().optional().describe('대표자명'),
    companyPartCd: z.string().optional().describe('분류코드 (제작사, 배급사, 상영업 등)'),
    curPage: z.string().optional().describe('페이지 번호 (기본 1)'),
    itemPerPage: z.string().optional().describe('페이지당 건수 (기본 10)')
  },
  async (params) => {
    try {
      const raw = await fetchKobis('/company/searchCompanyList.json', {
        ...params,
        curPage: params.curPage || '1',
        itemPerPage: params.itemPerPage || '10'
      });

      const data = raw?.companyListResult;
      const list = data?.companyList || [];
      const formatted = {
        총검색건수: data?.totCnt || list.length,
        목록: list.map((c: any) => ({
          영화사코드: c.companyCd,
          영화사명: c.companyNm,
          영문명: c.companyNmEn || '-',
          대표자명: c.ceoNm || '-',
          분류: c.companyPartNames || '-',
          대표필모그래피: c.filmoNames || '-'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 6. 영화사 상세 정보 조회
// ============================================================================
server.tool(
  'get_company_detail',
  '영화사코드(companyCd)로 영화사의 대표자명, 참여업종, 전체 필모그래피 목록을 조회합니다.',
  {
    companyCd: z.string().describe('영화사코드 (8자리 코드)')
  },
  async ({ companyCd }) => {
    try {
      const raw = await fetchKobis('/company/searchCompanyInfo.json', { companyCd });
      const info = raw?.companyInfoResult?.companyInfo;
      if (!info) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const formatted = {
        영화사코드: info.companyCd,
        영화사명: info.companyNm,
        영문명: info.companyNmEn || '-',
        대표자명: info.ceoNm || '-',
        참여업종: info.parts?.map((p: any) => p.companyPartNm).join(', ') || '-',
        총참여작품수: info.filmos ? `${info.filmos.length}편` : '0편',
        주요작품목록: info.filmos?.slice(0, 15).map((f: any) => ({
          영화코드: f.movieCd,
          영화명: f.movieNm,
          참여역할: f.companyPartNm
        })) || []
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 7. 영화인 목록 검색
// ============================================================================
server.tool(
  'search_people_list',
  '영화인 이름(peopleNm) 또는 출연/연출 영화명(filmoNames)으로 영화인 목록 및 코드를 검색합니다.',
  {
    peopleNm: z.string().optional().describe('영화인 이름 (배우, 감독, 스태프 등)'),
    filmoNames: z.string().optional().describe('출연 또는 제작 참여 영화명'),
    curPage: z.string().optional().describe('페이지 번호 (기본 1)'),
    itemPerPage: z.string().optional().describe('페이지당 건수 (기본 10)')
  },
  async (params) => {
    try {
      const raw = await fetchKobis('/people/searchPeopleList.json', {
        ...params,
        curPage: params.curPage || '1',
        itemPerPage: params.itemPerPage || '10'
      });

      const data = raw?.peopleListResult;
      const list = data?.peopleList || [];
      const formatted = {
        총검색건수: data?.totCnt || list.length,
        목록: list.map((p: any) => ({
          영화인코드: p.peopleCd,
          영화인명: p.peopleNm,
          영문명: p.peopleNmEn || '-',
          대표역할: p.repRoleNm || '-',
          대표필모그래피: p.filmoNames || '-'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 8. 영화인 상세 정보 조회
// ============================================================================
server.tool(
  'get_people_detail',
  '영화인코드(peopleCd)로 해당 인물(감독/배우)의 성별, 분야, 전체 필모그래피 목록을 조회합니다.',
  {
    peopleCd: z.string().describe('영화인코드 (8자리 코드)')
  },
  async ({ peopleCd }) => {
    try {
      const raw = await fetchKobis('/people/searchPeopleInfo.json', { peopleCd });
      const info = raw?.peopleInfoResult?.peopleInfo;
      if (!info) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const formatted = {
        영화인코드: info.peopleCd,
        영화인명: info.peopleNm,
        영문명: info.peopleNmEn || '-',
        성별: info.sex || '-',
        대표분야: info.repRoleNm || '-',
        총참여작품수: info.filmos ? `${info.filmos.length}편` : '0편',
        필모그래피: info.filmos?.map((f: any) => ({
          영화코드: f.movieCd,
          영화명: f.movieNm,
          담당역할: f.moviePartNm
        })) || []
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 9. 공통코드 조회
// ============================================================================
server.tool(
  'get_code_list',
  '영진위 오픈API 공통 코드(지역코드: 0105000000 등)를 조회합니다.',
  {
    comCode: z.string().default('0105000000').describe('조회할 상위 코드값 (지역코드: 0105000000)')
  },
  async ({ comCode }) => {
    try {
      const raw = await fetchKobis('/code/searchCodeList.json', {
        comCode: comCode || '0105000000'
      });

      const list = raw?.codes || [];
      const formatted = {
        상위코드: comCode,
        총건수: list.length,
        코드목록: list.map((c: any) => ({
          코드값: c.fullCd,
          코드명: c.korNm,
          영문명: c.engNm || '-'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Stdio 연결
const transport = new StdioServerTransport();
await server.connect(transport);
