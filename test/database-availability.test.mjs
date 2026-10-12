import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthMiddleware } from '../src/middlewares/auth.middleware.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';

const request = () => ({ header: name => name === 'Authorization' ? 'Bearer valid-token' : undefined });
const response = () => ({ statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const decoded = { id: 7, role: 'admin', version: 2 };

test('a pool timeout during valid authentication reaches the 503 handler without invalidating the token', async t => {
  t.mock.method(console, 'error', () => {});
  const timeout = new Error('timeout exceeded when trying to connect');
  const authenticate = createAuthMiddleware({ verify: () => decoded, loadState: async () => { throw timeout; } });
  const req = request(), res = response();
  let forwarded;
  await authenticate(req, res, error => { forwarded = error; });
  assert.equal(forwarded, timeout);
  assert.equal(res.body, undefined);
  errorMiddleware(forwarded, req, res, () => {});
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'DATABASE_UNAVAILABLE');
  assert.equal(res.headers['Retry-After'], '5');
});

test('invalid tokens and revoked users still receive 401', async () => {
  for (const setup of [
    { verify: () => { throw new Error('invalid signature'); } },
    { verify: () => decoded, loadState: async () => null },
    { verify: () => decoded, loadState: async () => ({ is_active: false, token_version: 2 }) },
    { verify: () => decoded, loadState: async () => ({ is_active: true, token_version: 3 }) },
  ]) {
    const res = response();
    await createAuthMiddleware(setup)(request(), res, () => assert.fail('invalid session must not proceed'));
    assert.equal(res.statusCode, 401);
  }
});

test('query cancellation is recoverable and unrelated errors keep their existing status', t => {
  t.mock.method(console, 'error', () => {});
  for (const [error, status] of [[Object.assign(new Error('statement timeout'), { code: '57014' }), 503], [Object.assign(new Error('not allowed'), { statusCode: 403 }), 403], [new Error('programming error'), 500]]) {
    const res = response();
    errorMiddleware(error, {}, res, () => {});
    assert.equal(res.statusCode, status);
  }
});
