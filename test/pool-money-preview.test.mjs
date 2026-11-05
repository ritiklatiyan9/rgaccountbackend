import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { createPoolMoneyPreviewApp, isPoolPreviewOrigin, poolPreviewPort } from '../scripts/pool-money-preview.mjs';

function request(app, { method = 'GET', path = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new PassThrough();
    const req = new IncomingMessage(socket);
    req.method = method; req.url = path; req.httpVersion = '1.1';
    req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.complete = true;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (payload) Object.assign(req.headers, { 'content-type': 'application/json', 'content-length': String(payload.length) });
    const res = new ServerResponse(req), chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Timed out: ${method} ${path}`)); }, 3000);
    socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
    res.assignSocket(socket); res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString(), text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: text ? JSON.parse(text) : null });
      socket.destroy();
    });
    app.handle(req, res); if (payload) req.push(payload); req.push(null);
  });
}

test('preview isolates routes, rejects foreign origins and requires session proof before module access', async t => {
  t.mock.method(console, 'error', () => {});
  let moduleReads = 0, dbReads = 0;
  const router = express.Router();
  router.get('/pool-money', (_req, res) => { moduleReads++; res.json({ rows: [] }); });
  const app = createPoolMoneyPreviewApp({
    authenticate: (req, res, next) => {
      if (req.header('Authorization') !== 'Bearer verified') return res.status(401).json({ message: 'Authentication required' });
      req.user = { id: 1, organization_id: 1, role: 'admin' }; next();
    },
    poolMoneyRouter: router,
    database: { query: async sql => { assert.match(sql, /^SELECT/); dbReads++; return { rows: [] }; } },
    audit: (_req, _res, next) => next(),
  });
  assert.equal((await request(app)).body.service, 'pool-money-preview');
  for (const path of ['/plots/pool-money', '/sites', '/sites/7']) assert.equal((await request(app, { path })).status, 401);
  assert.equal(moduleReads, 0); assert.equal(dbReads, 0);
  assert.equal((await request(app, { path: '/wallet' })).status, 404);
  assert.equal((await request(app, { path: '/plots/payments', method: 'POST', body: {} })).status, 404);
  assert.equal((await request(app, { headers: { Origin: 'https://foreign.example' } })).status, 403);
  const response = await request(app, { path: '/plots/pool-money', headers: { Authorization: 'Bearer verified' } });
  assert.equal(response.status, 200); assert.equal(moduleReads, 1); assert.equal(response.headers['cache-control'], 'no-store');
});

test('profile save and shop mutations retain org checks and reject unrelated changes', async () => {
  const calls = [];
  let actor = { id: 1, organization_id: 1, role: 'admin' };
  const router = express.Router();
  const app = createPoolMoneyPreviewApp({
    authenticate: (req, _res, next) => { req.user = actor; next(); }, poolMoneyRouter: router,
    database: { query: async (sql, args) => {
      assert.match(sql, /organization_id/);
      if (Number(args[0]) === 99) return { rows: [] };
      return { rows: [{ id: 7, site_id: 7, organization_id: 1, unit_type: 'shop', project_profile: { inventory_type: 'shops' } }] };
    } },
    saveProjectProfile: (req, res) => { calls.push(['profile', req.body]); res.json({ site: req.previewSite }); },
    createShop: (req, res) => { calls.push(['create', req.body]); res.status(201).json({ plot: { id: 1 } }); },
    updateShop: (req, res) => { calls.push(['update', req.body]); res.json({ plot: { id: 1 } }); },
    audit: (_req, _res, next) => next(),
  });
  assert.equal((await request(app, { path: '/sites/99' })).status, 404);
  assert.equal((await request(app, { path: '/sites/7x' })).status, 400);
  assert.equal((await request(app, { method: 'PUT', path: '/sites/7', body: { project_profile: {}, name: 'Different name' } })).status, 400);
  assert.equal((await request(app, { method: 'PUT', path: '/sites/7', body: { project_profile: { inventory_type: 'shops' } } })).status, 200);
  assert.equal((await request(app, { method: 'POST', path: '/plots', body: { site_id: 7, unit_type: 'plot' } })).status, 400);
  assert.equal((await request(app, { method: 'POST', path: '/plots', body: { site_id: 99, unit_type: 'shop' } })).status, 404);
  assert.equal((await request(app, { method: 'POST', path: '/plots', body: { site_id: 7, unit_type: 'shop' } })).status, 201);
  assert.equal((await request(app, { method: 'PUT', path: '/plots/1', body: { sale_price: 2500000 } })).status, 200);
  assert.equal((await request(app, { method: 'PUT', path: '/plots/1', body: { site_id: 8 } })).status, 400);
  actor = { ...actor, role: 'sub_admin' };
  assert.equal((await request(app, { method: 'PUT', path: '/sites/7', body: { project_profile: {} } })).status, 403);
  assert.deepEqual(calls.map(([action]) => action), ['profile', 'create', 'update']);
});

test('preview listening ports and browser origins are constrained', () => {
  assert.equal(poolPreviewPort('8009'), 8009);
  for (const port of [0, 65536, '8009oops', NaN]) assert.throws(() => poolPreviewPort(port));
  for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:5173']) assert.equal(isPoolPreviewOrigin(origin), true);
  for (const origin of ['http://localhost:5174', 'https://example.com', 'http://127.0.0.1:5173.evil.example']) assert.equal(isPoolPreviewOrigin(origin), false);
});
