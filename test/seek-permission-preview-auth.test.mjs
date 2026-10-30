import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createSeekPermissionPreviewAuth, SEEK_PREVIEW_AUTH_URL } from '../src/middlewares/seekPermissionPreviewAuth.middleware.js';
import { initSocket, emitToUser } from '../src/config/socket.js';

const baseUser = { id: 5, name: 'Requester', organization_id: 1, role: 'sub_admin', is_active: true,
  token_version: 3, can_login_accounts: true, can_login_booking_accounts: false, session_id: 123, session_logout_time: null };
const startTime = 2000000000000;
const token = (changes = {}, signature = 'signature') => [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ id: 5, role: 'sub_admin', version: 3, app: 'accounts', exp: startTime / 1000 + 3600, ...changes })).toString('base64url'), signature].join('.');

function fixture(options = {}) {
  const state = { user: { ...baseUser }, remote: { ...baseUser }, status: 200, calls: [], queries: [], time: startTime,
    offline: false, wait: null, ...options };
  const bridge = createSeekPermissionPreviewAuth({ database: { query: async (sql, params) => {
    state.queries.push({ sql, params }); return { rows: state.user ? [{ ...state.user }] : [] };
  } }, now: () => state.time, maxProofs: state.maxProofs, request: async (url, settings) => {
    state.calls.push({ url, settings });
    if (state.wait) await state.wait;
    if (state.offline) throw new Error('offline');
    return { status: state.status, ok: state.status === 200, json: async () => ({ user: state.remote }) };
  } });
  const credentials = { token: token(), sessionId: 123, appContext: 'accounts', origin: 'http://127.0.0.1:5174' };
  return { state, bridge, credentials };
}
const rejects = (promise, status) => assert.rejects(promise, error => error.statusCode === status);

test('hosted proof is fixed to Accounts, cached by token/session and coalesced, while every call rechecks DB', async () => {
  let release;
  const { state, bridge, credentials } = fixture({ wait: new Promise(resolve => { release = resolve; }) });
  const first = bridge.resolve(credentials);
  const second = bridge.resolve(credentials);
  assert.equal(state.calls.length, 1);
  release();
  assert.equal((await first).user.id, 5);
  assert.equal((await second).user.role, 'sub_admin');
  await bridge.resolve(credentials);
  assert.equal(state.calls.length, 1);
  assert.equal(state.queries.length, 3);
  const { url, settings } = state.calls[0];
  assert.equal(url, SEEK_PREVIEW_AUTH_URL);
  assert.equal(settings.redirect, 'error');
  assert.equal(settings.headers.Authorization, `Bearer ${credentials.token}`);
  assert.equal(settings.headers['X-Session-ID'], '123');
  assert.equal(settings.headers['X-App-Context'], 'accounts');
  await bridge.resolve({ ...credentials, token: token({}, 'otherSignature') });
  assert.equal(state.calls.length, 2, 'tokens never share proof because their payloads happen to match');
  state.user.session_id = 124;
  await bridge.resolve({ ...credentials, sessionId: 124 });
  assert.equal(state.calls.length, 3, 'session bindings never share proof');
});

test('current local active status, role, organization, token version, app and session revocations apply immediately', async () => {
  for (const change of [{ is_active: false }, { role: 'admin' }, { organization_id: 2 }, { token_version: 4 },
    { session_id: null }, { session_logout_time: new Date() }, { can_login_accounts: false }]) {
    const { bridge, state, credentials } = fixture();
    await bridge.resolve(credentials);
    Object.assign(state.user, change);
    await rejects(bridge.resolve(credentials), change.can_login_accounts === false ? 403 : 401);
    assert.equal(state.calls.length, 1, 'cached proof does not cache local permission checks');
  }
  const { bridge, state, credentials } = fixture();
  await rejects(bridge.resolve({ ...credentials, sessionId: undefined }), 401);
  assert.equal(state.queries.length, 0, 'a logged-out bearer cannot omit its session to bypass the sessions table');
  state.calls.length = 0;
  await bridge.resolve(credentials);
  state.user = null;
  await rejects(bridge.resolve(credentials), 401);
});

test('preview outbound socket events recheck current token version/logout and skip revoked recipients', async () => {
  const { bridge, state, credentials } = fixture();
  const server = createServer();
  const io = initSocket(server, { authorizeUserDelivery: bridge.authorizeUserDelivery });
  const events = [];
  let disconnects = 0;
  const socket = { connected: true, handshake: { auth: { token: credentials.token, sessionId: 123, appContext: 'accounts' },
    headers: { origin: credentials.origin } }, emit: (...args) => events.push(args), disconnect: () => { disconnects++; } };
  io.sockets.sockets.set('preview-test', socket);
  io.sockets.adapter.rooms.set('user_5', new Set(['preview-test']));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    emitToUser(5, 'seek_permission:comment', { request_id: 1 });
    await settle();
    assert.equal(events.length, 1);
    assert.equal(state.calls.length, 1);
    state.user.token_version++;
    emitToUser(5, 'seek_permission:changed', { id: 1, title: 'Must not be delivered' });
    await settle();
    assert.equal(events.length, 1);
    assert.equal(disconnects, 1);
    state.user.token_version--;
    state.user.session_logout_time = new Date();
    emitToUser(5, 'seek_permission:comment', { request_id: 1 });
    await settle();
    assert.equal(events.length, 1);
    assert.equal(disconnects, 2);
  } finally {
    io.sockets.sockets.delete('preview-test');
    io.sockets.adapter.rooms.delete('user_5');
    await new Promise(resolve => io.close(resolve));
  }
});

test('expired, mismatched, invalid upstream and spoofed application/origin proofs never authenticate', async () => {
  for (const status of [401, 403, 503]) {
    const { bridge, state, credentials } = fixture({ status });
    await rejects(bridge.resolve(credentials), status);
    assert.equal(state.queries.length, 0);
  }
  const offline = fixture({ offline: true });
  await rejects(offline.bridge.resolve(offline.credentials), 503);
  for (const changes of [{ exp: startTime / 1000 - 1 }, { id: 6 }, { version: -1 }, { app: 'booking_accounts' }, { realm: 'client' }]) {
    const { bridge, state, credentials } = fixture();
    await rejects(bridge.resolve({ ...credentials, token: token(changes) }), changes.app || changes.realm ? 403 : 401);
    assert.equal(state.queries.length, 0);
  }
  const { bridge, state, credentials } = fixture();
  for (const changes of [{ appContext: 'booking_accounts' }, { origin: 'https://www.dgbooking.com' },
    { origin: 'http://127.0.0.1:5174.evil.example' }, { sessionId: '123oops' }]) {
    await assert.rejects(bridge.resolve({ ...credentials, ...changes }));
  }
  assert.equal(state.calls.length, 0, 'untrusted app/origin/session input never reaches an arbitrary upstream');
});

test('proof TTL/expiry and bounded cache force revalidation; outages are 503 and do not revoke valid sessions', async () => {
  const { bridge, state, credentials } = fixture({ maxProofs: 1 });
  await bridge.resolve(credentials);
  await bridge.resolve({ ...credentials, token: token({}, 'secondSignature') });
  await bridge.resolve(credentials);
  assert.equal(state.calls.length, 3, 'oldest proof is evicted at capacity');
  state.time += 60001;
  state.offline = true;
  await rejects(bridge.resolve(credentials), 503);
  state.offline = false;
  await bridge.resolve(credentials);
  assert.equal(state.calls.length, 5);
  state.time += 3600000;
  await rejects(bridge.resolve(credentials), 401);
});

test('HTTP and socket authentication share proof/session identity and sockets cannot spoof session bindings', async () => {
  const { bridge, state, credentials } = fixture();
  const req = { header: name => ({ Authorization: `Bearer ${credentials.token}`, 'X-Session-ID': '123',
    'X-App-Context': 'accounts', Origin: credentials.origin })[name] };
  const res = { status(code) { this.statusCode = code; return this; }, set() { return this; }, json(body) { this.body = body; return this; } };
  let next = false;
  await bridge.authenticate(req, res, () => { next = true; });
  assert.equal(next, true);
  const socket = { handshake: { auth: { token: credentials.token, sessionId: 123, appContext: 'accounts' }, headers: { origin: credentials.origin } } };
  let socketError;
  await bridge.authenticateSocket(socket, error => { socketError = error; });
  assert.equal(socketError, undefined);
  assert.equal(socket.user.id, req.user.id);
  assert.equal(socket.sessionId, 123);
  assert.equal(state.calls.length, 1);
  assert.equal(state.queries.length, 2);
  state.user.session_logout_time = new Date();
  await bridge.authenticateSocket(socket, error => { socketError = error; });
  assert.equal(socketError.data.status, 401);
  state.user.session_logout_time = null;
  socket.handshake.auth.sessionId = 999;
  await bridge.authenticateSocket(socket, error => { socketError = error; });
  assert.equal(socketError.data.status, 401);
  const outage = fixture({ offline: true });
  const outageResponse = { ...res };
  await outage.bridge.authenticate(req, outageResponse, () => assert.fail('unavailable proof must not authenticate'));
  assert.equal(outageResponse.statusCode, 503);
});
