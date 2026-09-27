import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/cache-retention-plan';

function retentionPlan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('single access interval fully covered by cache is retained whole', async () => {
  const res = await retentionPlan({
    size: 1000,
    cached: [{ start: 0, end: 499 }],
    accesses: [{ start: 100, end: 199, weight: 5 }],
    budgetBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, [{ start: 100, end: 199 }]);
  assert.equal(body.retainedBytes, 100);
  assert.equal(body.unusedBytes, 0);
});

test('overlapping cache intervals are counted once', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [
      { start: 0, end: 49 },
      { start: 25, end: 74 },
      { start: 10, end: 20 },
    ],
    accesses: [{ start: 0, end: 99, weight: 1 }],
    budgetBytes: 1000,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Merged cache is [0,74] = 75 bytes; the budget cannot retain more.
  assert.deepEqual(body.retained, [{ start: 0, end: 74 }]);
  assert.equal(body.retainedBytes, 75);
  assert.equal(body.unusedBytes, 925);
});

test('overlapping accesses accumulate weight and win the budget', async () => {
  const res = await retentionPlan({
    size: 1000,
    cached: [{ start: 0, end: 999 }],
    accesses: [
      { start: 0, end: 99, weight: 1 },
      { start: 50, end: 149, weight: 1 },
    ],
    budgetBytes: 75,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Cumulative weights: [0,49]=1, [50,99]=2, [100,149]=1. The overlap
  // [50,99] goes first; the remaining 25 bytes come from the lowest offsets
  // of the weight-1 segments.
  assert.deepEqual(body.retained, [
    { start: 0, end: 24 },
    { start: 50, end: 99 },
  ]);
  assert.equal(body.retainedBytes, 75);
  assert.equal(body.unusedBytes, 0);
});

test('higher weight beats lower offset; equal weight keeps offset order', async () => {
  const res = await retentionPlan({
    size: 1000,
    cached: [{ start: 0, end: 999 }],
    accesses: [
      { start: 0, end: 49, weight: 1 },
      { start: 100, end: 149, weight: 5 },
      { start: 200, end: 249, weight: 5 },
    ],
    budgetBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, [
    { start: 100, end: 149 },
    { start: 200, end: 249 },
  ]);
  assert.equal(body.retainedBytes, 100);
  assert.equal(body.unusedBytes, 0);
});

test('budget may cut off inside an interval, keeping the lowest offsets', async () => {
  const res = await retentionPlan({
    size: 1000,
    cached: [{ start: 0, end: 999 }],
    accesses: [{ start: 0, end: 499, weight: 3 }],
    budgetBytes: 120,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, [{ start: 0, end: 119 }]);
  assert.equal(body.retainedBytes, 120);
  assert.equal(body.unusedBytes, 0);
});

test('only cached bytes with positive value are retained', async () => {
  const res = await retentionPlan({
    size: 1000,
    cached: [{ start: 0, end: 99 }],
    accesses: [{ start: 50, end: 199, weight: 7 }],
    budgetBytes: 500,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // [0,49] is cached but worthless, [100,199] is valuable but not cached.
  assert.deepEqual(body.retained, [{ start: 50, end: 99 }]);
  assert.equal(body.retainedBytes, 50);
  assert.equal(body.unusedBytes, 450);
});

test('adjacent selected intervals merge into one', async () => {
  const res = await retentionPlan({
    size: 1000,
    cached: [{ start: 0, end: 99 }],
    accesses: [
      { start: 0, end: 49, weight: 2 },
      { start: 50, end: 99, weight: 2 },
    ],
    budgetBytes: 100,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, [{ start: 0, end: 99 }]);
  assert.equal(body.retainedBytes, 100);
  assert.equal(body.unusedBytes, 0);
});

test('zero budget retains nothing', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [{ start: 0, end: 49 }],
    accesses: [{ start: 0, end: 49, weight: 1 }],
    budgetBytes: 0,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, []);
  assert.equal(body.retainedBytes, 0);
  assert.equal(body.unusedBytes, 0);
});

test('empty cache leaves the whole budget unused', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [],
    accesses: [{ start: 0, end: 49, weight: 1 }],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, []);
  assert.equal(body.retainedBytes, 0);
  assert.equal(body.unusedBytes, 10);
});

test('empty accesses leave the whole budget unused', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [{ start: 0, end: 49 }],
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, []);
  assert.equal(body.retainedBytes, 0);
  assert.equal(body.unusedBytes, 10);
});

test('empty resource retains nothing', async () => {
  const res = await retentionPlan({ size: 0, cached: [], accesses: [], budgetBytes: 10 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, []);
  assert.equal(body.retainedBytes, 0);
  assert.equal(body.unusedBytes, 10);
});

test('weighted accesses across disjoint cache regions fill the budget exactly', async () => {
  const res = await retentionPlan({
    size: 10000,
    cached: [
      { start: 0, end: 999 },
      { start: 2000, end: 2999 },
    ],
    accesses: [
      { start: 100, end: 199, weight: 5 },
      { start: 150, end: 249, weight: 3 },
      { start: 2100, end: 2199, weight: 10 },
    ],
    budgetBytes: 150,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // Cumulative weights: [100,149]=5, [150,199]=8, [200,249]=3, [2100,2199]=10.
  // Budget 150 takes [2100,2199] (100 bytes) then [150,199] (50 bytes).
  assert.deepEqual(body.retained, [
    { start: 150, end: 199 },
    { start: 2100, end: 2199 },
  ]);
  assert.equal(body.retainedBytes, 150);
  assert.equal(body.unusedBytes, 0);
});

test('large offsets stay within safe-integer precision', async () => {
  const size = Number.MAX_SAFE_INTEGER;
  const res = await retentionPlan({
    size,
    cached: [{ start: size - 10, end: size - 1 }],
    accesses: [{ start: size - 10, end: size - 1, weight: 1000000 }],
    budgetBytes: 5,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.retained, [{ start: size - 10, end: size - 6 }]);
  assert.equal(body.retainedBytes, 5);
  assert.equal(body.unusedBytes, 0);
});

test('non-integer or negative size is rejected', async () => {
  for (const size of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await retentionPlan({ size, cached: [], accesses: [], budgetBytes: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for size=${size}`);
  }
});

test('budgetBytes must be a non-negative safe integer', async () => {
  for (const budgetBytes of [-1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await retentionPlan({ size: 100, cached: [], accesses: [], budgetBytes });
    assert.equal(res.statusCode, 400, `expected 400 for budgetBytes=${budgetBytes}`);
  }
});

test('cached must be an array of interval objects', async () => {
  for (const cached of [null, {}, '0-9', [null], [1], [['0', '9']], [{ start: 0 }], [{ start: 0, end: 9, extra: 1 }]]) {
    const res = await retentionPlan({ size: 100, cached, accesses: [], budgetBytes: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for cached=${JSON.stringify(cached)}`);
  }
});

test('cached interval count is capped at 1000', async () => {
  const interval = { start: 0, end: 0 };
  const ok = await retentionPlan({
    size: 100,
    cached: Array.from({ length: 1000 }, () => interval),
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(ok.statusCode, 200);
  const tooMany = await retentionPlan({
    size: 100,
    cached: Array.from({ length: 1001 }, () => interval),
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(tooMany.statusCode, 400);
});

test('cached interval boundaries must be non-negative safe integers', async () => {
  for (const interval of [
    { start: -1, end: 9 },
    { start: 0, end: -1 },
    { start: 0.5, end: 9 },
    { start: 0, end: 9.5 },
    { start: '0', end: 9 },
  ]) {
    const res = await retentionPlan({ size: 100, cached: [interval], accesses: [], budgetBytes: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(interval)}`);
  }
});

test('cached interval with start after end is rejected', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [{ start: 50, end: 10 }],
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CACHED_RANGE');
});

test('cached interval reaching past the resource end is rejected', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [{ start: 90, end: 100 }],
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('any cached interval is out of bounds on an empty resource', async () => {
  const res = await retentionPlan({
    size: 0,
    cached: [{ start: 0, end: 0 }],
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('accesses must be an array of weighted interval objects', async () => {
  for (const accesses of [
    null,
    {},
    '0-9',
    [null],
    [1],
    [{ start: 0, end: 9 }],
    [{ start: 0, end: 9, weight: 1, extra: 1 }],
  ]) {
    const res = await retentionPlan({ size: 100, cached: [], accesses, budgetBytes: 10 });
    assert.equal(res.statusCode, 400, `expected 400 for accesses=${JSON.stringify(accesses)}`);
  }
});

test('access interval count is capped at 1000', async () => {
  const interval = { start: 0, end: 0, weight: 1 };
  const ok = await retentionPlan({
    size: 100,
    cached: [],
    accesses: Array.from({ length: 1000 }, () => interval),
    budgetBytes: 10,
  });
  assert.equal(ok.statusCode, 200);
  const tooMany = await retentionPlan({
    size: 100,
    cached: [],
    accesses: Array.from({ length: 1001 }, () => interval),
    budgetBytes: 10,
  });
  assert.equal(tooMany.statusCode, 400);
});

test('access weight must be a positive integer within the cap', async () => {
  for (const weight of [0, -1, 1.5, '5', 1000001]) {
    const res = await retentionPlan({
      size: 100,
      cached: [],
      accesses: [{ start: 0, end: 9, weight }],
      budgetBytes: 10,
    });
    assert.equal(res.statusCode, 400, `expected 400 for weight=${weight}`);
  }
  const res = await retentionPlan({
    size: 100,
    cached: [{ start: 0, end: 9 }],
    accesses: [{ start: 0, end: 9, weight: 1000000 }],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 200);
});

test('access interval with start after end is rejected', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [],
    accesses: [{ start: 50, end: 10, weight: 1 }],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_ACCESS_RANGE');
});

test('access interval reaching past the resource end is rejected', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [],
    accesses: [{ start: 90, end: 100, weight: 1 }],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'ACCESS_RANGE_OUT_OF_BOUNDS');
});

test('missing required fields are rejected by schema validation', async () => {
  for (const payload of [
    {},
    { size: 100 },
    { size: 100, cached: [] },
    { size: 100, cached: [], accesses: [] },
  ]) {
    const res = await retentionPlan(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('unknown top-level fields are rejected', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [],
    accesses: [],
    budgetBytes: 10,
    eviction: 'lru',
  });
  assert.equal(res.statusCode, 400);
});

test('error responses carry the shared error shape', async () => {
  const res = await retentionPlan({
    size: 100,
    cached: [{ start: 5, end: 1 }],
    accesses: [],
    budgetBytes: 10,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, 'Bad Request');
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
});

test('existing /plan endpoint is unaffected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { Range: 'bytes=0-99', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 10000 }),
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 1);
});
