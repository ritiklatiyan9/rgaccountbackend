import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { requestAppContext, assertAppLoginAccess } from '../src/services/appLoginAccess.js';
import { createAuthMiddleware, createAuthStateLoader } from '../src/middlewares/auth.middleware.js';
import { migrationSql } from '../src/migrations/228_booking_accounts_login_access.js';

const request = (origin = 'https://www.dgdefence.com', app, extra = {}) => {
  const headers = { authorization: 'Bearer test', ...(origin ? { origin } : {}), ...(app ? { 'x-app-context': app } : {}) };
  return { headers, header: name => headers[name.toLowerCase()], get: name => headers[name.toLowerCase()], ...extra };
};
const denied = (operation) => assert.throws(operation, error => error.statusCode === 403 && error.code === 'APP_ACCESS_DENIED');

test('production origins determine the app; explicit context cannot override it', () => {
  for (const origin of ['https://dgdefence.com', 'https://www.dgdefence.com']) {
    assert.equal(requestAppContext(request(origin)), 'accounts');
    denied(() => requestAppContext(request(origin, 'booking_accounts')));
  }
  for (const origin of ['https://dgbooking.com', 'https://www.dgbooking.com']) {
    assert.equal(requestAppContext(request(origin)), 'booking_accounts');
    denied(() => requestAppContext(request(origin, 'accounts')));
  }
  assert.equal(requestAppContext(request('http://localhost:5173', 'booking_accounts')), 'booking_accounts');
  assert.equal(requestAppContext(request(null)), 'accounts');
  denied(() => requestAppContext(request(null, '__proto__')));
  denied(() => requestAppContext(request('not an origin')));
});

test('application grants and JWT realms are independent for all eight permission combinations', () => {
  for (const accounts of [false, true]) for (const booking of [false, true]) for (const bookingAccounts of [false, true]) {
    const user = { role: 'sub_admin', can_login_accounts: accounts, can_login_booking: booking, can_login_booking_accounts: bookingAccounts };
    for (const [app, allowed, token] of [['accounts', accounts, { app: 'accounts' }], ['booking_accounts', bookingAccounts, { app: 'booking' }]]) {
      if (allowed) assert.doesNotThrow(() => assertAppLoginAccess(user, app, token));
      else denied(() => assertAppLoginAccess(user, app, token));
    }
    denied(() => assertAppLoginAccess(user, 'accounts', { app: 'booking' }));
    denied(() => assertAppLoginAccess(user, 'accounts', { app: 'booking_accounts' }));
    denied(() => assertAppLoginAccess(user, 'booking_accounts', { app: 'accounts' }));
  }
  denied(() => assertAppLoginAccess({ role: 'client' }, 'accounts'));
  denied(() => assertAppLoginAccess({ role: 'admin' }, 'accounts', { realm: 'mobile' }));
});

test('real database flags revoke existing requests immediately without revoking another app', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE users(id integer PRIMARY KEY, name text, role text, token_version integer, is_active boolean, organization_id integer);
    CREATE TABLE user_sessions(id integer PRIMARY KEY, user_id integer, logout_time timestamptz);
    INSERT INTO users VALUES(7,'Operator','sub_admin',4,true,1);
    ALTER TABLE users ADD COLUMN can_login_booking boolean NOT NULL DEFAULT TRUE;
    UPDATE users SET can_login_booking=false;`);
  await db.exec(migrationSql);
  assert.equal((await db.query('SELECT can_login_booking_accounts FROM users')).rows[0].can_login_booking_accounts, false, 'existing Booking denial carries into the new replica permission');
  const loadState = createAuthStateLoader(db);
  const auth = createAuthMiddleware({ verify: () => ({ id: 7, version: 4, role: 'sub_admin', app: 'booking' }), loadState });
  const invoke = req => new Promise(resolve => {
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    auth(req, res, error => resolve(error ? { status: error.statusCode, body: { code: error.code } } : { status: 200 }));
  });
  const embedded = () => request('https://www.dgbooking.com', 'booking_accounts');
  await db.exec('UPDATE users SET can_login_accounts=false, can_login_booking=true, can_login_booking_accounts=true');
  assert.equal((await invoke(embedded())).status, 200, 'requested scenario retains Booking Account access');
  assert.equal((await invoke(request())).status, 403, 'Booking token cannot enter standalone Accounts');
  await db.exec('UPDATE users SET can_login_booking_accounts=false');
  assert.deepEqual(await invoke(embedded()), { status: 403, body: { code: 'APP_ACCESS_DENIED' } });
  await db.exec('UPDATE users SET can_login_booking_accounts=true, can_login_booking=false');
  assert.equal((await invoke(embedded())).status, 200, 'replica permission is independent from Booking');
  await db.exec(migrationSql);
  const { rows: [saved] } = await db.query('SELECT can_login_accounts,can_login_booking,can_login_booking_accounts FROM users');
  assert.deepEqual(saved, { can_login_accounts: false, can_login_booking: false, can_login_booking_accounts: true }, 'rerunning migration preserves explicit choices');
  await db.exec('UPDATE users SET is_active=false');
  assert.equal((await invoke(embedded())).status, 401);
});

function controllerHarness() {
  const source = readFileSync(new URL('../src/controllers/auth.controller.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');
  const state = { user: { id: 7, role: 'sub_admin', is_active: true, token_version: 4, can_login_accounts: false, can_login_booking: true, can_login_booking_accounts: true }, token: { id: 7, version: 4, app: 'booking' }, challenge: null, writes: 0 };
  const context = { process, console, requestAppContext, assertAppLoginAccess, asyncHandler: fn => fn,
    userModel: { findById: async () => state.user, findByLoginIdentifier: async () => state.user, update: async () => state.user, sanitize: user => user },
    siteModel: { findAll: async () => [], findByUserId: async () => [] }, permissionModel: { getByUserId: async () => [] },
    hashRefreshToken: async () => 'hash', writeAuditLog: async () => {}, mailerEnabled: () => false,
    firebaseEnabled: () => true, verifyFirebaseIdToken: async () => ({ email: 'operator@test', email_verified: true, firebase: { sign_in_provider: 'google.com' } }),
    comparePassword: async () => true,
    verifyToken: () => state.token, signAccessToken: payload => payload, signRefreshToken: payload => payload,
    pool: { query: async sql => { if (sql.includes('lower(email)')) return { rows: [state.user] }; if (sql.startsWith('SELECT')) return { rows: state.challenge ? [state.challenge] : [] }; state.writes++; return { rows: [{ id: 12 }] }; } },
  };
  vm.createContext(context); vm.runInContext(`${source}\nthis.handlers={login,googleLogin,refresh,verifyLoginOtp,resendLoginOtp};`, context);
  const invoke = async (name, req) => {
    let result;
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { result = { status: this.statusCode || 200, body }; } };
    try { await context.handlers[name](req, res); }
    catch (error) { result = { status: error.statusCode, body: { code: error.code, message: error.message } }; }
    return result;
  };
  return { state, invoke };
}

test('refresh checks the current app grant and keeps a shared Booking session in its original realm', async () => {
  const { state, invoke } = controllerHarness();
  const req = () => request('https://www.dgbooking.com', 'booking_accounts', { body: { refreshToken: 'refresh' } });
  let result = await invoke('refresh', req());
  assert.equal(result.status, 200);
  assert.equal(result.body.accessToken.app, 'booking');
  assert.equal(result.body.refreshToken.app, 'booking');
  result = await invoke('refresh', request('https://www.dgdefence.com', 'accounts', { body: { refreshToken: 'refresh' } }));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'APP_ACCESS_DENIED');
  delete state.token.app;
  assert.equal((await invoke('refresh', req())).body.accessToken.app, 'booking', 'legacy shared sessions retain Booking compatibility');
  state.user.can_login_booking_accounts = false;
  assert.equal((await invoke('refresh', req())).status, 403);
  state.token.app = 'accounts';
  assert.equal((await invoke('refresh', req())).status, 403);
});

test('password login and OTP completion cannot bypass app grants or reuse another app challenge', async () => {
  const { state, invoke } = controllerHarness();
  assert.equal((await invoke('login', request(undefined, 'accounts', { body: { identifier: 'user', password: 'secret' } }))).status, 403);
  state.challenge = { id: 1, user_id: 7, app_context: 'booking', expires_at: new Date(Date.now() + 60000).toISOString(), attempts: 0 };
  for (const handler of ['verifyLoginOtp', 'resendLoginOtp']) {
    const result = await invoke(handler, request('https://www.dgbooking.com', 'booking_accounts', { body: { pending_token: 'challenge', otp: '123456' } }));
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'APP_ACCESS_DENIED');
  }
  assert.equal(state.writes, 0, 'wrong-app challenge is neither consumed nor resent');
  state.challenge.app_context = 'accounts';
  assert.equal((await invoke('verifyLoginOtp', request(undefined, 'accounts', { body: { pending_token: 'challenge', otp: '123456' } }))).status, 403);
  assert.equal(state.writes, 0, 'revoked app cannot complete a valid challenge');
});


test('password and Google sign-in mint only the permitted target realm', async () => {
  const { state, invoke } = controllerHarness();
  for (const name of ['login', 'googleLogin']) {
    const body = { identifier: 'operator@test', password: 'secret', credential: 'google-test' };
    assert.equal((await invoke(name, request(undefined, 'accounts', { body }))).status, 403);
    const embedded = await invoke(name, request('https://dgbooking.com', 'booking_accounts', { body }));
    assert.equal(embedded.status, 200);
    assert.equal(embedded.body.accessToken.app, 'booking_accounts');
    assert.equal(embedded.body.refreshToken.app, 'booking_accounts');
    state.user.can_login_booking_accounts = false;
    assert.equal((await invoke(name, request('https://dgbooking.com', 'booking_accounts', { body }))).status, 403);
    state.user.can_login_accounts = true;
    const standalone = await invoke(name, request(undefined, 'accounts', { body }));
    assert.equal(standalone.status, 200);
    assert.equal(standalone.body.accessToken.app, 'accounts');
    state.user.can_login_accounts = false;
    state.user.can_login_booking_accounts = true;
  }
});

test('socket authentication and selective revocation respect the same app boundary', async () => {
  const source = readFileSync(new URL('../src/config/socket.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ').replace(/export function /g, 'function ');
  let server;
  let user = { id: 7, role: 'sub_admin', is_active: true, token_version: 4, can_login_accounts: false, can_login_booking_accounts: true };
  class Server {
    constructor() { server = this; this.sockets = { sockets: new Map() }; }
    use(fn) { this.authenticate = fn; }
    on() {}
  }
  const context = { Server, requestAppContext, assertAppLoginAccess, verifyToken: () => ({ id: 7, version: 4, app: 'booking' }), pool: { query: async () => ({ rows: [user] }) } };
  vm.createContext(context); vm.runInContext(`${source}\nthis.start=initSocket; this.disconnect=disconnectUserAppSockets;`, context);
  context.start({});
  const connect = (origin, appContext) => new Promise(resolve => {
    const socket = { handshake: { headers: { origin }, auth: { token: 'test', appContext } } };
    server.authenticate(socket, error => resolve({ socket, error }));
  });
  assert.equal((await connect('https://www.dgbooking.com', 'booking_accounts')).error, undefined);
  assert.ok((await connect('https://www.dgdefence.com', 'booking_accounts')).error);
  user = { ...user, can_login_booking_accounts: false };
  assert.ok((await connect('https://www.dgbooking.com', 'booking_accounts')).error);
  const disconnected = [];
  for (const [id, userId, app] of [['a', 7, 'accounts'], ['b', 7, 'booking_accounts'], ['c', 9, 'booking_accounts']]) {
    server.sockets.sockets.set(id, { user: { id: userId }, appContext: app, disconnect: () => disconnected.push(id) });
  }
  context.disconnect(7, 'booking_accounts');
  assert.deepEqual(disconnected, ['b']);
});
