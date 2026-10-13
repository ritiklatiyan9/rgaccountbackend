import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.CACHE_ENABLED = 'true';

const { cacheGet, cacheSet, clearCacheByPrefixes } = await import('../config/cache.js');
const { cacheResponse, invalidateCacheOnSuccess, buildCacheKey } = await import('./cache.middleware.js');

const makeResponse = () => ({
  statusCode: 200,
  headers: {},
  setHeader(name, value) {
    this.headers[name] = value;
  },
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return payload;
  },
});

test('an in-flight read cannot repopulate cache after invalidation', async () => {
  const namespace = `daybook-race-${Date.now()}`;
  const middleware = cacheResponse({ ttlSeconds: 30, namespace });
  const req = {
    method: 'GET',
    path: '/',
    query: { site_id: 3 },
    headers: {},
    user: { id: 7 },
  };
  const res = makeResponse();
  const key = buildCacheKey(req, namespace);

  await new Promise((resolve) => middleware(req, res, resolve));
  await clearCacheByPrefixes(['mutation-that-advances-generation']);
  res.json({ entries: ['stale'] });

  assert.equal(await cacheGet(key), null);
});

test('an uninterrupted read is cached normally', async () => {
  const namespace = `daybook-fresh-${Date.now()}`;
  const middleware = cacheResponse({ ttlSeconds: 30, namespace });
  const req = {
    method: 'GET',
    path: '/',
    query: { site_id: 4 },
    headers: {},
    user: { id: 8 },
  };
  const res = makeResponse();
  const key = buildCacheKey(req, namespace);

  await new Promise((resolve) => middleware(req, res, resolve));
  res.json({ entries: ['fresh'] });

  assert.deepEqual((await cacheGet(key))?.payload, { entries: ['fresh'] });
});

test('large responses can opt out of the in-process cache', async () => {
  const namespace = `balance-sheet-large-${Date.now()}`;
  const middleware = cacheResponse({
    ttlSeconds: 30,
    namespace,
    shouldCache: (payload) => (payload?.transactions?.length || 0) <= 2,
  });
  const req = {
    method: 'GET',
    path: '/',
    query: { site_id: 8 },
    headers: {},
    user: { id: 9 },
  };
  const res = makeResponse();
  const key = buildCacheKey(req, namespace);

  await new Promise((resolve) => middleware(req, res, resolve));
  res.json({ transactions: [{ id: 1 }, { id: 2 }, { id: 3 }] });

  assert.equal(await cacheGet(key), null);
  assert.equal(res.headers['X-Cache'], 'MISS');
});

// Analytics combines clients, plots and approvals, so each successful domain
// mutation must expire it even when the route only names its own cache.
test('successful writes invalidate analytics but rejected writes preserve it', async () => {
  const key = 'management-analytics|u:7|/clients/map|site_id=3';
  for (const status of [403, 200]) {
    await cacheSet(key, { map: { total: 1 } });
    const res = Object.assign(new EventEmitter(), makeResponse());
    res.statusCode = status;
    invalidateCacheOnSuccess(['plots|'])({ method: 'PUT' }, res, () => {});
    res.json({ ok: status === 200 });
    res.emit('finish');
    assert.equal((await cacheGet(key)) !== null, status === 403);
  }
});

test('a cached analytics response rechecks current site access and forwards revocation errors', async () => {
  const namespace = `access-race-${Date.now()}`;
  const denied = Object.assign(new Error('Access denied to this site'), { statusCode: 403 });
  const middleware = cacheResponse({ namespace, authorizeHit: async () => { throw denied; } });
  const req = { method: 'GET', path: '/clients', query: { site_id: 3 }, headers: {}, user: { id: 7 } };
  await cacheSet(buildCacheKey(req, namespace), { statusCode: 200, payload: { confidential: true } });
  const res = makeResponse();
  let error;
  await middleware(req, res, value => { error = value; });
  assert.equal(error, denied); assert.equal(res.payload, undefined);
});

test('query strings containing delimiters cannot collide with another filter combination', async () => {
  const namespace = `query-key-${Date.now()}`;
  const middleware = cacheResponse({ namespace });
  const req = { method: 'GET', path: '/', query: { a: '1&b=2' }, headers: {}, user: { id: 7 } };
  const first = makeResponse(); await middleware(req, first, () => {}); first.json({ private: 'first' });
  const second = makeResponse(); let missed = false;
  await middleware({ ...req, query: { a: '1', b: '2' } }, second, () => { missed = true; });
  assert.equal(missed, true); assert.equal(second.payload, undefined);
});

test('financial reports always execute their own authorization boundary, and statements authorize sites before caching', async () => {
  const { readFile } = await import('node:fs/promises');
  const reports = await readFile(new URL('../routes/report.routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(reports, /cacheResponse/);
  const statement = await readFile(new URL('../routes/balanceSheet.routes.js', import.meta.url), 'utf8');
  const statementRoute = statement.slice(statement.indexOf("router.get(\n  '/'"));
  assert.ok(statementRoute.indexOf('requireRegistrySiteAccess') < statementRoute.indexOf('cacheResponse'));
});

test('cache keys isolate roles, organisations, sessions and row visibility even for the same user', () => {
  const req = { path: '/', query: { site_id: 1 }, user: { id: 7, role: 'sub_admin', organization_id: 1, version: 1,
    permissionsByModule: new Map([['daybook', { can_read: true, can_view_all: false }]]) }, sessionId: 1 };
  const key = buildCacheKey(req);
  for (const change of [ { ...req, sessionId: 2 },
    ...[{ role: 'admin' }, { organization_id: 2 }, { version: 2 },
      { permissionsByModule: new Map([['daybook', { can_read: true, can_view_all: true }]]) }]
      .map(user => ({ ...req, user: { ...req.user, ...user } })),
  ]) assert.notEqual(buildCacheKey(change), key);
});
