process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pageSchema,
  targetDtSchema,
  enqueue,
  toolHandler,
  RATE_LIMIT_MS
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
