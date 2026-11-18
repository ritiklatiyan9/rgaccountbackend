import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { createPoolMoneyPreviewApp, isPoolPreviewOrigin, poolPreviewPort } from '../scripts/pool-money-preview.mjs';
import { createMemberKycRouter } from '../src/routes/memberKyc.routes.js';

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
      const raw = Buffer.concat(chunks).toString();
      let text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      if (res.getHeader('transfer-encoding') === 'chunked' || /^HTTP\/1\.1[^\r]+\r\n[\s\S]*?transfer-encoding: chunked/i.test(raw)) {
        let remaining = text; text = '';
        while (remaining.length) {
          const end = remaining.indexOf('\r\n');
          const size = Number.parseInt(remaining.slice(0, end), 16);
          if (!size) break;
          text += remaining.slice(end + 2, end + 2 + size);
          remaining = remaining.slice(end + 2 + size + 2);
        }
      }
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
    memberKycRouter: createMemberKycRouter({ authenticate: (_req, _res, next) => next() }),
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
  const startKyc = { method: 'POST', path: '/member-kyc/cases', body: { require_new_member: true } };
  assert.equal((await request(app, startKyc)).status, 401);
  const invalidKyc = await request(app, { ...startKyc, headers: { Authorization: 'Bearer verified' } });
  assert.equal(invalidKyc.status, 400);
  assert.equal(invalidKyc.headers['cache-control'], 'no-store');
});

test('profile save and property mutations retain org checks and reject unrelated changes', async () => {
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
  assert.equal((await request(app, { method: 'POST', path: '/plots', body: { site_id: 7, unit_type: 'plot' } })).status, 201);
  assert.equal((await request(app, { method: 'POST', path: '/plots', body: { site_id: 99, unit_type: 'shop' } })).status, 404);
  assert.equal((await request(app, { method: 'POST', path: '/plots', body: { site_id: 7, unit_type: 'shop' } })).status, 201);
  assert.equal((await request(app, { method: 'PUT', path: '/plots/1', body: { sale_price: 2500000 } })).status, 200);
  assert.equal((await request(app, { method: 'PUT', path: '/plots/1', body: { site_id: 8 } })).status, 400);
  actor = { ...actor, role: 'sub_admin' };
  assert.equal((await request(app, { method: 'PUT', path: '/sites/7', body: { project_profile: {} } })).status, 403);
  assert.deepEqual(calls.map(([action]) => action), ['profile', 'create', 'create', 'update']);
});

test('preview listening ports and browser origins are constrained', () => {
  assert.equal(poolPreviewPort('8009'), 8009);
  for (const port of [0, 65536, '8009oops', NaN]) assert.throws(() => poolPreviewPort(port));
  for (const origin of [undefined, 'http://localhost:5173', 'http://127.0.0.1:5173']) assert.equal(isPoolPreviewOrigin(origin), true);
  for (const origin of ['http://localhost:5174', 'https://example.com', 'http://127.0.0.1:5173.evil.example']) assert.equal(isPoolPreviewOrigin(origin), false);
});

test('booking preview retains session authentication for member links and exposes only plot GraphQL fields', async () => {
  const router = express.Router(), members = express.Router();
  members.get('/plot-options', (_req, res) => res.json({ plots: [] }));
  const app = createPoolMoneyPreviewApp({
    authenticate: (req, res, next) => {
      if (req.header('Authorization') !== 'Bearer verified') return res.status(401).json({ message: 'Authentication required' });
      req.user = { id: 1, organization_id: 1, role: 'admin' }; next();
    },
    poolMoneyRouter: router, memberRouter: members, plotGraphql: true,
    database: { query: async () => { throw new Error('This schema check must not query live records'); } },
    audit: (_req, _res, next) => next(),
  });
  assert.equal((await request(app, { path: '/members/plot-options' })).status, 401);
  assert.equal((await request(app, { path: '/graphql', method: 'POST', body: { query: '{ __typename }' } })).status, 401);
  const headers = { Authorization: 'Bearer verified' };
  assert.equal((await request(app, { path: '/members/plot-options', headers })).status, 200);
  const response = await request(app, { path: '/graphql', method: 'POST', headers, body: { query: '{ __schema { queryType { fields { name } } mutationType { fields { name } } } }' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.__schema.queryType.fields.map(field => field.name).sort(), ['plotPageData', 'plotPaymentDetail']);
  assert.deepEqual(response.body.data.__schema.mutationType.fields.map(field => field.name), ['invalidatePlotCache']);
  assert.equal((await request(app)).body.plot_co_applicants, true);
});

test('optional NOC preview exposes only the five guarded certificate routes', async () => {
  const calls=[];
  const handler=name=>(req,res)=>{calls.push(name);res.json({route:name,id:req.params.id});};
  const options={
    authenticate:(req,res,next)=>{
      if(req.header('Authorization')!=='Bearer verified')return res.status(401).json({message:'Authentication required'});
      req.user={id:1,organization_id:1,role:'admin'};next();
    },
    poolMoneyRouter:express.Router(),registryNoc:true,
    nocHandlers:Object.fromEntries(['getRegistryNoc','saveRegistryNoc','approveRegistryNoc','getPlotNocRegistry','createPlotNocRegistry'].map(name=>[name,handler(name)])),
    audit:(_req,_res,next)=>next(),
  };
  const app=createPoolMoneyPreviewApp(options);
  const paths=[['GET','/registries/1/noc'],['PUT','/registries/1/noc'],['PUT','/registries/1/noc/approve'],['GET','/plots/1/registry-noc'],['POST','/plots/1/noc-workspace']];
  for(const [method,path] of paths)assert.equal((await request(app,{method,path})).status,401);
  assert.deepEqual(calls,[]);
  for(const [method,path] of paths)assert.equal((await request(app,{method,path,headers:{Authorization:'Bearer verified'},...(method==='GET'?{}:{body:{}})})).status,200);
  assert.equal(calls.length,5);
  for(const [method,path] of [['GET','/registries'],['GET','/registries/1'],['POST','/registries'],['PUT','/registries/1'],['DELETE','/registries/1']])assert.equal((await request(app,{method,path,headers:{Authorization:'Bearer verified'}})).status,404);
  const disabled=createPoolMoneyPreviewApp({...options,registryNoc:false});
  assert.equal((await request(disabled,{path:'/registries/1/noc'})).status,404);
});
