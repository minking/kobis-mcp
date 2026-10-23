process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pageSchema,
  targetDtSchema,
  enqueue,
  createRateLimiter,
  toolHandler,
  RATE_LIMIT_MS,
  TOOL_DEFS,
  createServer
} from '../dist/index.js';

test('targetDtSchema: YYYYMMDD 날짜 형식 검증', () => {
  assert.equal(targetDtSchema.safeParse('20260911').success, true);
  assert.equal(targetDtSchema.safeParse('2026-09-11').success, false);
  assert.equal(targetDtSchema.safeParse('2026091').success, false);
  assert.equal(targetDtSchema.safeParse('202609110').success, false);
  assert.equal(targetDtSchema.safeParse('abcdefgh').success, false);
});

test('pageSchema: 페이징 파라미터 정규식 검증', () => {
  const curPageRes = pageSchema.curPage.safeParse('1');
  assert.equal(curPageRes.success, true);

  const invalidPage = pageSchema.curPage.safeParse('first');
  assert.equal(invalidPage.success, false);

  const invalidNegative = pageSchema.curPage.safeParse('-1');
  assert.equal(invalidNegative.success, false);
});

test('toolHandler: 정상 결과 래핑 및 예외 발생 시 에러 포맷팅 검증', async () => {
  const successHandler = toolHandler(async (x) => ({ result: x.val * 2 }));
  const successRes = await successHandler({ val: 5 });
  assert.equal(successRes.isError, undefined);
  assert.match(successRes.content[0].text, /"result": 10/);

  const errorHandler = toolHandler(async () => {
    throw new Error('KOBIS 인증 실패');
  });
  const errorRes = await errorHandler({});
  assert.equal(errorRes.isError, true);
  assert.equal(errorRes.content[0].text, '오류: KOBIS 인증 실패');
});

test('enqueue: 순차 동기화(Sequential Sync), 응답 완료 후 간격 보장 및 에러 격리 검증', async () => {
  const executionOrder = [];
  const timestamps = [];
  const start = Date.now();

  // 1. 순차 실행 및 이전 작업 완료(약 30ms) 후 간격(50ms) 대기 검증
  const p1 = enqueue(async () => {
    executionOrder.push(1);
    timestamps.push(Date.now());
    await new Promise((r) => setTimeout(r, 30));
    return 'first';
  }, 50);

  const p2 = enqueue(async () => {
    executionOrder.push(2);
    timestamps.push(Date.now());
    return 'second';
  }, 50);

  const [r1, r2] = await Promise.all([p1, p2]);
  const elapsed = Date.now() - start;

  assert.equal(r1, 'first');
  assert.equal(r2, 'second');
  assert.deepEqual(executionOrder, [1, 2]);
  // p2는 p1 완료(30ms) 이후 50ms 대기 후 실행되므로 최소 75ms 이상 소요되어야 함
  assert.ok(elapsed >= 75, `응답 완료 후 최소 간격 이상 소요되어야 함 (실제: ${elapsed}ms)`);
  assert.ok(timestamps[1] - timestamps[0] >= 75, `두 번째 작업 시작은 첫 번째 작업 시작 + 실행시간 + 대기시간 이후여야 함`);

  // 2. 에러 격리 테스트: 앞선 작업이 실패해도 다음 작업 정상 실행 및 간격 보장
  const pError = enqueue(async () => {
    throw new Error('의도된 작업 실패');
  }, 10);

  const pSuccess = enqueue(async () => {
    return '성공 복구';
  }, 10);

  await assert.rejects(pError, { message: '의도된 작업 실패' });
  const successRes = await pSuccess;
  assert.equal(successRes, '성공 복구');
});

test('createRateLimiter: 인스턴스별 독립 큐 (stateless-safe 서버 팩토리 검증)', async () => {
  const limiterA = createRateLimiter();
  const limiterB = createRateLimiter();

  // 두 리미터는 서로 다른 클로저 상태를 가지므로 독립적으로 동작해야 함
  const order = [];
  const a = limiterA.enqueue(async () => { order.push('a'); return 'a'; }, 0);
  const b = limiterB.enqueue(async () => { order.push('b'); return 'b'; }, 0);
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);

  // 기본 간격 상수 노출 확인
  assert.equal(RATE_LIMIT_MS, 250);
});

test('TOOL_DEFS: 최신 스펙 도구 정의完整性 (title/outputSchema/annotations 구성)', () => {
  assert.equal(TOOL_DEFS.length, 9);
  for (const def of TOOL_DEFS) {
    assert.ok(def.name && def.title && def.description, `${def.name}: title/description 필수`);
    assert.ok(def.endpoint.startsWith('/'), `${def.name}: 엔드포인트 형식`);
    // Strict Tools: 입력 스키마는 strict object (additionalProperties:false)
    const jsonSchema = def.inputSchema.toJSONSchema({ io: 'input' });
    assert.equal(jsonSchema.type, 'object', `${def.name}: inputSchema 타입`);
    assert.equal(jsonSchema.additionalProperties, false, `${def.name}: strict 입력(additionalProperties:false)`);
    // 출력 스키마 존재 (structuredContent 라운드트립 검증용)
    const outSchema = def.outputSchema.toJSONSchema({ io: 'output' });
    assert.equal(outSchema.type, 'object', `${def.name}: outputSchema 존재`);
  }

  const daily = TOOL_DEFS.find((t) => t.name === 'get_daily_boxoffice');
  const dailyJson = daily.inputSchema.toJSONSchema({ io: 'input' });
  assert.deepEqual(dailyJson.required, ['targetDt']);
  assert.equal(dailyJson.properties.targetDt.pattern, '^\\d{8}$');
});

test('createServer: stateless 서버 팩토 — 독립 인스턴스 생성 가능', () => {
  const s1 = createServer();
  const s2 = createServer();
  assert.ok(s1 !== s2, '서버 팩토리는 매 호출 새 인스턴스를 반환해야 함(HTTP stateless 배포 지원)');
});
