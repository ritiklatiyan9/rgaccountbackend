import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthStateLoader } from '../src/middlewares/auth.middleware.js';

test('coalesces concurrent validation for the same user and session only while in flight', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const db = {
    async query(_sql, params) {
      calls += 1;
      await gate;
      return { rows: [{ id: params[0], session_id: params[1] }] };
    },
  };
  const load = createAuthStateLoader(db);

  const first = load(7, 11);
  const second = load(7, 11);
  assert.equal(calls, 1);
  assert.strictEqual(first, second);

  release();
  assert.deepEqual(await first, { id: 7, session_id: 11 });
  await load(7, 11);
  assert.equal(calls, 2, 'completed lookups must not be cached');
});

test('does not share validation across sessions', async () => {
  let calls = 0;
  const db = {
    async query(_sql, params) {
      calls += 1;
      return { rows: [{ id: params[0], session_id: params[1] }] };
    },
  };
  const load = createAuthStateLoader(db);

  await Promise.all([load(7, 11), load(7, 12), load(8, 11)]);
  assert.equal(calls, 3);
});
