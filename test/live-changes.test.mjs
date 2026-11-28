import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLiveChanges } from '../src/middlewares/liveChanges.middleware.js';

test('only successful signed-in writes ping, once per burst, after caches are cleared', async () => {
  const calls = [];
  const middleware = createLiveChanges({ delayMs: 5, emit: (org, event) => calls.push([event, org]), clear: async () => calls.push(['clear']) });
  const hit = (method, path, statusCode = 200, user = { organization_id: 3 }) => {
    const res = Object.assign(new EventEmitter(), { statusCode });
    middleware({ method, path, user }, res, () => {});
    res.emit('finish');
  };
  hit('GET', '/approvals/pending');
  hit('POST', '/graphql');
  hit('POST', '/seek-permissions/seen');
  hit('PUT', '/approvals/1/approve', 409);
  hit('PUT', '/approvals/1/approve', 200, null);
  assert.deepEqual(calls, []);
  hit('PUT', '/approvals/1/approve');
  hit('POST', '/expenses');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, [['clear'], ['clear'], ['data:changed', 3]]);
});
