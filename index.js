#!/usr/bin/env node
import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const server = new McpServer({
  name: 'kobis-mcp',
  version: '1.4.0',
});

// ============================================================================
// 영진위 오픈API 규약 준수: 
// 1) 1일 3,000회 제한 방어 (Quota & Smart Cache)
// 2) 초당 호출 빈도 제한 (Rate Throttling: 최소 250ms 간격, 초당 최대 4회)
// 3) 네트워크 일시 장애 및 429(Too Many Requests) 지수 백오프 자동 재시도
// ============================================================================
const BASE_URL = 'http://www.kobis.or.kr/kobisopenapi/webservice/rest';
const CACHE_DIR = path.join(os.homedir(), '.kobis-cache');
const QUOTA_FILE = path.join(CACHE_DIR, 'quota.json');
const MAX_DAILY_CALLS = 2950; // 영진위 1일 3,000회 제한 중 안전 마진 50회 확보
const MIN_INTERVAL_MS = 250;  // 초당 최대 4회로 연속 급증 호출 제한

let lastRequestTime = 0;

async function throttleRequest() {
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < MIN_INTERVAL_MS) {
    const waitMs = MIN_INTERVAL_MS - timeSinceLast;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  lastRequestTime = Date.now();
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getQuota() {
  ensureCacheDir();
  const today = getTodayString();
  if (fs.existsSync(QUOTA_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
      if (data.date === today) {
        return data;
      }
    } catch (e) {}
  }
  const init = { date: today, count: 0 };
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(init, null, 2), 'utf8');
  return init;
}

function checkAndIncrementQuota() {
  const quota = getQuota();
  if (quota.count >= MAX_DAILY_CALLS) {
    throw new Error(`[영진위 API 안전 리미터 작동] 오늘 영진위 1일 호출 한도(${quota.count}/${MAX_DAILY_CALLS}회)를 모두 소진했습니다. API 키 정지 방지를 위해 오늘 자정까지 추가 호출이 차단됩니다.`);
  }
  quota.count += 1;
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(quota, null, 2), 'utf8');
  return quota.count;
}

function getCacheKey(endpoint, params) {
  const cleanParams = { ...params };
  delete cleanParams.key;
  const str = endpoint + JSON.stringify(cleanParams);
  return crypto.createHash('md5').update(str).digest('hex');
}

function getFromCache(key, ttlSeconds = 86400 * 30) {
  ensureCacheDir();
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (fs.existsSync(file)) {
    try {
      const { timestamp, data } = JSON.parse(fs.readFileSync(file, 'utf8'));
      const age = (Date.now() - timestamp) / 1000;
      if (age < ttlSeconds) {
        return data;
      }
    } catch (e) {}
  }
  return null;
}

function saveToCache(key, data) {
  ensureCacheDir();
  const file = path.join(CACHE_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), data }), 'utf8');
}

function checkApiKey() {
  const key = process.env.KOBIS_API_KEY || '';
  if (!key) {
    throw new Error('KOBIS_API_KEY가 설정되지 않았습니다. .env 파일이나 mcp_config.json에 영진위 API 키를 설정해주세요.');
  }
  return key;
}

// 스마트 캐싱, 초당 속도 제어(Throttling), 재시도(Retry) 통합 실행기
async function fetchKobis(endpoint, params, ttlSeconds = 86400 * 30) {
  const cacheKey = getCacheKey(endpoint, params);
  const cached = getFromCache(cacheKey, ttlSeconds);
  if (cached) {
    return { data: cached, fromCache: true };
  }

  const key = checkApiKey();
  checkAndIncrementQuota();

  const url = `${BASE_URL}${endpoint}`;
  const retries = 2;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await throttleRequest();
      const res = await axios.get(url, {
        params: { key, ...params },
        timeout: 10000,
        headers: {
          'User-Agent': 'kobis-mcp/1.4.0 (Model Context Protocol)'
        }
      });

      if (res.data) {
        saveToCache(cacheKey, res.data);
      }
      return { data: res.data, fromCache: false };
    } catch (err) {
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
}

// ============================================================================
// 1. 일별 박스오피스 (Daily BoxOffice)
// ============================================================================
server.tool(
  'get_daily_boxoffice',
  '특정 일자(YYYYMMDD)의 박스오피스 순위, 당일 관객수, 누적 관객수, 매출액, 점유율, 스크린수 등을 조회합니다. (과거 일자는 자동 로컬 캐싱되어 API 할당량을 소모하지 않습니다)',
  {
    targetDt: z.string().describe('조회 일자 (YYYYMMDD 형식, 예: 20260902)'),
    itemPerPage: z.string().optional().describe('조회 건수 (기본값 10, 최대 10)'),
    multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부 (Y: 다양성, N: 상업영화, 미지정시 전체)'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분 (K: 한국, F: 외국, 미지정시 전체)'),
    wideAreaCd: z.string().optional().describe('지역코드 (서울: 0105001 등)')
  },
  async ({ targetDt, itemPerPage, multiMovieYn, repNationCd, wideAreaCd }) => {
    try {
      const todayStr = getTodayString().replace(/-/g, '');
      const isPast = targetDt < todayStr;
      const ttl = isPast ? 86400 * 365 : 3600;

      const { data: raw, fromCache } = await fetchKobis('/boxoffice/searchDailyBoxOfficeList.json', {
        targetDt,
        itemPerPage: itemPerPage || '10',
        multiMovieYn,
        repNationCd,
        wideAreaCd
      }, ttl);

      const data = raw?.boxOfficeResult;
      if (!data || !data.dailyBoxOfficeList) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const quota = getQuota();
      const formatted = {
        조회구분: data.boxofficeType || '일별 박스오피스',
        조회일자: targetDt,
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환 (API 호출 0회 소모)' : `🌐 실시간 API 호출 (오늘 사용량: ${quota.count}/${MAX_DAILY_CALLS}회)`,
        목록: data.dailyBoxOfficeList.map(m => ({
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
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 2. 주간/주말 박스오피스 (Weekly BoxOffice)
// ============================================================================
server.tool(
  'get_weekly_boxoffice',
  '특정 주(해당 주의 일요일 YYYYMMDD)의 주말(금~일) 또는 주간 박스오피스 순위, 관객수 및 매출액을 조회합니다. (자동 로컬 캐싱 적용)',
  {
    targetDt: z.string().describe('해당 주의 일요일 일자 (YYYYMMDD 형식, 예: 20260830)'),
    weekGb: z.enum(['0', '1', '2']).default('1').describe('조회 기간 구분 (0: 주간(월~일), 1: 주말(금~일) [기본값], 2: 주중(월~목))'),
    itemPerPage: z.string().optional().describe('조회 건수 (기본값 10)'),
    multiMovieYn: z.enum(['Y', 'N']).optional().describe('다양성 영화 여부'),
    repNationCd: z.enum(['K', 'F']).optional().describe('한국/외국 영화 구분'),
    wideAreaCd: z.string().optional().describe('지역코드')
  },
  async ({ targetDt, weekGb, itemPerPage, multiMovieYn, repNationCd, wideAreaCd }) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/boxoffice/searchWeeklyBoxOfficeList.json', {
        targetDt,
        weekGb: weekGb || '1',
        itemPerPage: itemPerPage || '10',
        multiMovieYn,
        repNationCd,
        wideAreaCd
      }, 86400 * 30);

      const data = raw?.boxOfficeResult;
      if (!data || !data.weeklyBoxOfficeList) {
        return {
          content: [{ type: 'text', text: JSON.stringify(raw, null, 2) }]
        };
      }

      const quota = getQuota();
      const formatted = {
        조회구분: data.boxofficeType || '주간/주말 박스오피스',
        조회기간: data.showRange,
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환 (API 호출 0회 소모)' : `🌐 실시간 API 호출 (오늘 사용량: ${quota.count}/${MAX_DAILY_CALLS}회)`,
        목록: data.weeklyBoxOfficeList.map(m => ({
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
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 3. 영화 목록 검색 (Movie List Search)
// ============================================================================
server.tool(
  'search_movie_list',
  '영화 제목, 감독명, 제작연도, 개봉연도 키워드로 영화 목록 및 영화코드를 검색합니다. (로컬 캐싱 적용)',
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
      const { data: raw, fromCache } = await fetchKobis('/movie/searchMovieList.json', {
        ...params,
        curPage: params.curPage || '1',
        itemPerPage: params.itemPerPage || '10'
      }, 86400 * 7);

      const data = raw?.movieListResult;
      const list = data?.movieList || [];
      const formatted = {
        총검색건수: data?.totCnt || list.length,
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        목록: list.map(m => ({
          영화코드: m.movieCd,
          영화명: m.movieNm,
          영문명: m.movieNmEn,
          제작연도: m.prdtYear,
          개봉일: m.openDt,
          유형: m.typeNm,
          장르: m.genreAlt,
          감독: m.directors?.map(d => d.peopleNm).join(', ') || '-',
          제작사: m.companys?.map(c => c.companyNm).join(', ') || '-'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 4. 영화 상세 정보 조회 (Movie Detail)
// ============================================================================
server.tool(
  'get_movie_detail',
  '영화코드(movieCd)로 상영시간, 관람등급, 장르, 감독, 주요배우, 배급사, 제작사 등 상세 정보를 조회합니다. (로컬 캐싱 적용)',
  {
    movieCd: z.string().describe('영화코드 (8자리 영진위 고유 코드)')
  },
  async ({ movieCd }) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/movie/searchMovieInfo.json', { movieCd }, 86400 * 30);
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
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        상영시간: info.showTm ? `${info.showTm}분` : '-',
        제작연도: info.prdtYear,
        개봉일: info.openDt,
        장르: info.genres?.map(g => g.genreNm).join(', ') || '-',
        감독: info.directors?.map(d => d.peopleNm).join(', ') || '-',
        주요배우: info.actors?.slice(0, 8).map(a => `${a.peopleNm}(${a.cast || '배역'})`).join(', ') || '-',
        관람등급: info.audits?.map(a => a.watchGradeNm).join(', ') || '-',
        배급사: info.companys?.filter(c => c.companyPartNm === '배급사').map(c => c.companyNm).join(', ') || '-',
        제작사: info.companys?.filter(c => c.companyPartNm === '제작사').map(c => c.companyNm).join(', ') || '-',
        스태프요약: info.staffs?.slice(0, 5).map(s => `${s.staffRoleNm}: ${s.peopleNm}`).join(', ') || '-'
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 5. 영화사 목록 검색 (Company List)
// ============================================================================
server.tool(
  'search_company_list',
  '영화사 이름(companyNm)이나 대표자명으로 영화사 목록 및 고유코드를 검색합니다. (로컬 캐싱 적용)',
  {
    companyNm: z.string().optional().describe('영화사명 키워드 (예: 씨제이, 롯데, 쇼박스)'),
    ceoNm: z.string().optional().describe('대표자명'),
    companyPartCd: z.string().optional().describe('분류코드 (제작사, 배급사, 상영업 등)'),
    curPage: z.string().optional().describe('페이지 번호 (기본 1)'),
    itemPerPage: z.string().optional().describe('페이지당 건수 (기본 10)')
  },
  async (params) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/company/searchCompanyList.json', {
        ...params,
        curPage: params.curPage || '1',
        itemPerPage: params.itemPerPage || '10'
      }, 86400 * 14);

      const data = raw?.companyListResult;
      const list = data?.companyList || [];
      const formatted = {
        총검색건수: data?.totCnt || list.length,
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        목록: list.map(c => ({
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
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 6. 영화사 상세 정보 조회 (Company Detail)
// ============================================================================
server.tool(
  'get_company_detail',
  '영화사코드(companyCd)로 영화사의 대표자명, 참여업종, 전체 필모그래피 목록을 조회합니다. (로컬 캐싱 적용)',
  {
    companyCd: z.string().describe('영화사코드 (8자리 코드)')
  },
  async ({ companyCd }) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/company/searchCompanyInfo.json', { companyCd }, 86400 * 30);
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
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        참여업종: info.parts?.map(p => p.companyPartNm).join(', ') || '-',
        총참여작품수: info.filmos ? `${info.filmos.length}편` : '0편',
        주요작품목록: info.filmos?.slice(0, 15).map(f => ({
          영화코드: f.movieCd,
          영화명: f.movieNm,
          참여역할: f.companyPartNm
        })) || []
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 7. 영화인 목록 검색 (People List)
// ============================================================================
server.tool(
  'search_people_list',
  '영화인 이름(peopleNm) 또는 출연/연출 영화명(filmoNames)으로 영화인 목록 및 코드를 검색합니다. (로컬 캐싱 적용)',
  {
    peopleNm: z.string().optional().describe('영화인 이름 (배우, 감독, 스태프 등)'),
    filmoNames: z.string().optional().describe('출연 또는 제작 참여 영화명'),
    curPage: z.string().optional().describe('페이지 번호 (기본 1)'),
    itemPerPage: z.string().optional().describe('페이지당 건수 (기본 10)')
  },
  async (params) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/people/searchPeopleList.json', {
        ...params,
        curPage: params.curPage || '1',
        itemPerPage: params.itemPerPage || '10'
      }, 86400 * 14);

      const data = raw?.peopleListResult;
      const list = data?.peopleList || [];
      const formatted = {
        총검색건수: data?.totCnt || list.length,
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        목록: list.map(p => ({
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
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 8. 영화인 상세 정보 조회 (People Detail)
// ============================================================================
server.tool(
  'get_people_detail',
  '영화인코드(peopleCd)로 해당 인물(감독/배우)의 성별, 분야, 전체 필모그래피 목록을 조회합니다. (로컬 캐싱 적용)',
  {
    peopleCd: z.string().describe('영화인코드 (8자리 코드)')
  },
  async ({ peopleCd }) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/people/searchPeopleInfo.json', { peopleCd }, 86400 * 30);
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
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        총참여작품수: info.filmos ? `${info.filmos.length}편` : '0편',
        필모그래피: info.filmos?.map(f => ({
          영화코드: f.movieCd,
          영화명: f.movieNm,
          담당역할: f.moviePartNm
        })) || []
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 9. 공통코드 조회 (Common Codes)
// ============================================================================
server.tool(
  'get_code_list',
  '영진위 오픈API 공통 코드(지역코드: 0105000000 등)를 조회합니다. (로컬 캐싱 적용)',
  {
    comCode: z.string().default('0105000000').describe('조회할 상위 코드값 (지역코드: 0105000000)')
  },
  async ({ comCode }) => {
    try {
      const { data: raw, fromCache } = await fetchKobis('/code/searchCodeList.json', {
        comCode: comCode || '0105000000'
      }, 86400 * 60);

      const list = raw?.codes || [];
      const formatted = {
        상위코드: comCode,
        총건수: list.length,
        캐시상태: fromCache ? '⚡ 로컬 캐시 반환' : '🌐 실시간 API 호출',
        코드목록: list.map(c => ({
          코드값: c.fullCd,
          코드명: c.korNm,
          영문명: c.engNm || '-'
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `오류: ${err.message}` }],
        isError: true
      };
    }
  }
);

// ============================================================================
// 10. 오늘 API 사용량 및 캐시 상태 조회 (Quota Status)
// ============================================================================
server.tool(
  'get_quota_status',
  '오늘 하루 사용한 영진위 API 호출 횟수(최대 3,000회 제한 중 사용량), 잔여 호출 가능 횟수, 속도 제한 규약 및 로컬 캐시 상태를 조회합니다.',
  {},
  async () => {
    try {
      ensureCacheDir();
      const quota = getQuota();
      const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json') && f !== 'quota.json');
      const remaining = Math.max(0, MAX_DAILY_CALLS - quota.count);

      const status = {
        기준일자: quota.date,
        일일호출한도: '3,000회/일',
        안전임계한도: `${MAX_DAILY_CALLS}회 (자동 차단 보호)`,
        오늘호출횟수: `${quota.count}회`,
        남은호출횟수: `${remaining}회`,
        할당량소진율: ((quota.count / MAX_DAILY_CALLS) * 100).toFixed(1) + '%',
        속도제한규약: `최소 ${MIN_INTERVAL_MS}ms 간격 강제 (초당 최대 4회 스팸 방지)`,
        장애대응: 'HTTP 429 / 503 발생 시 지수 백오프 자동 2회 재시도',
        로컬캐시항목수: `${files.length}개`,
        캐시저장경로: CACHE_DIR,
        안내: '이미 조회한 과거 박스오피스나 영화 정보는 로컬 캐시에서 즉시 반환되므로 API 호출 횟수가 차감되지 않습니다.'
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
      };
    } catch (err) {
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
