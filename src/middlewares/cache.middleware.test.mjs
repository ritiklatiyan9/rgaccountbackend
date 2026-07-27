import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CACHE_ENABLED = 'true';

const { cacheGet, clearCacheByPrefixes } = await import('../config/cache.js');
const { cacheResponse } = await import('./cache.middleware.js');

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
  const key = `${namespace}|u:7|/|site_id=3`;
  const middleware = cacheResponse({ ttlSeconds: 30, namespace });
  const req = {
    method: 'GET',
    path: '/',
    query: { site_id: 3 },
    headers: {},
    user: { id: 7 },
  };
  const res = makeResponse();

  await new Promise((resolve) => middleware(req, res, resolve));
  await clearCacheByPrefixes(['mutation-that-advances-generation']);
  res.json({ entries: ['stale'] });

  assert.equal(await cacheGet(key), null);
});

test('an uninterrupted read is cached normally', async () => {
  const namespace = `daybook-fresh-${Date.now()}`;
  const key = `${namespace}|u:8|/|site_id=4`;
  const middleware = cacheResponse({ ttlSeconds: 30, namespace });
  const req = {
    method: 'GET',
    path: '/',
    query: { site_id: 4 },
    headers: {},
    user: { id: 8 },
  };
  const res = makeResponse();

  await new Promise((resolve) => middleware(req, res, resolve));
  res.json({ entries: ['fresh'] });

  assert.deepEqual((await cacheGet(key))?.payload, { entries: ['fresh'] });
});
