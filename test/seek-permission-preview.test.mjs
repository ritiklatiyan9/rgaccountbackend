import assert from 'node:assert/strict';
import test from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.JWT_ACCESS_SECRET = 'seek-preview-test-secret';
const { createSeekPermissionPreviewApp, createSeekPermissionPreviewServer, assertSeekPreviewBaseSchema,
  isSeekPreviewOrigin, seekPreviewPort, startSeekPermissionPreview } = await import('../scripts/seek-permission-preview.mjs');
const { default: pool } = await import('../src/config/db.js');
const { signAccessToken } = await import('../src/config/jwt.js');
const { default: normalAuthentication } = await import('../src/middlewares/auth.middleware.js');
const { migrationSql: requestsSql } = await import('../src/migrations/222_seek_permissions.js');
const { migrationSql: targetsSql } = await import('../src/migrations/223_seek_permission_targets.js');
const { migrationSql: commentsSql } = await import('../src/migrations/230_seek_permission_comments.js');
const { migrationSql: prioritySql } = await import('../src/migrations/231_seek_permission_priority.js');

// Drive the actual Node HTTP request/response objects through Express without
// opening a listening socket or contacting the configured production database.
function request(app, { method = 'GET', path = '/health', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new PassThrough();
    const req = new IncomingMessage(socket);
    req.method = method;
    req.url = path;
    req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.complete = true;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (payload) Object.assign(req.headers, { 'content-type': 'application/json', 'content-length': String(payload.length) });
    const res = new ServerResponse(req);
    const deadline = setTimeout(() => { socket.destroy(); reject(new Error(`Preview test request timed out: ${method} ${path}`)); }, 2000);
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(deadline);
      const raw = Buffer.concat(chunks).toString();
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      resolve({ status: res.statusCode, headers: res.getHeaders(), body: text ? JSON.parse(text) : null });
      socket.destroy();
    });
    app.handle(req, res);
    if (payload) req.push(payload);
    req.push(null);
  });
}

test('preview mounts only Seek Permission, keeps real authentication, and enforces current site/role permissions', async t => {
  t.mock.method(console, 'error', () => {});
  const db = new PGlite();
  const originalQuery = pool.query;
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY, name text, organization_id int);
      CREATE TABLE users(id int PRIMARY KEY, name text, role text, organization_id int, is_active boolean,
        token_version int DEFAULT 0, can_login_accounts boolean DEFAULT true, can_login_booking_accounts boolean DEFAULT true);
      CREATE TABLE user_sites(user_id int, site_id int);
      CREATE TABLE user_sessions(id int, user_id int, logout_time timestamptz);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      INSERT INTO sites VALUES (1, 'Site one', 1), (2, 'Site two', 1);
      INSERT INTO users(id,name,role,organization_id,is_active) VALUES (1,'Admin','admin',1,true),
        (5,'Requester','sub_admin',1,true),(6,'Other site','sub_admin',1,true),(7,'Employee','employee',1,true);
      INSERT INTO user_sites VALUES (5,1),(6,2),(7,1);
      ${requestsSql} ${targetsSql} ${commentsSql} ${prioritySql}
      INSERT INTO seek_permissions(site_id,requested_by,asked_to,title) VALUES (1,5,1,'Advance approval');`);
    pool.query = (...args) => db.query(...args);
    const app = createSeekPermissionPreviewApp({ authenticate: normalAuthentication });
    const origin = 'http://127.0.0.1:5174';
    assert.equal((await request(app)).status, 200);
    assert.equal((await request(app, { path: '/wallet' })).status, 404);
    assert.equal((await request(app, { path: '/seek-permissions?site_id=1' })).status, 401);
    assert.equal((await request(app, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(app, { method: 'OPTIONS', path: '/seek-permissions/1/comments',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,x-session-id,x-app-context' } })).status, 204);
    const auth = actor => ({ Origin: origin, Authorization: `Bearer ${signAccessToken({ id: actor.id, role: actor.role, version: 0, app: 'accounts' })}` });
    const requester = auth({ id: 5, role: 'sub_admin' });
    const created = await request(app, { method:'POST',path:'/seek-permissions',headers:requester,
      body:{site_id:1,asked_to:1,title:'Critical approval',priority:'critical'} });
    assert.equal(created.status,201); assert.equal(created.body.request.priority,'critical');
    const criticalInbox = await request(app,{path:'/seek-permissions/inbox?site_id=1',headers:auth({id:1,role:'admin'})});
    assert.equal(criticalInbox.body.received.find(row=>row.id===created.body.request.id).priority,'critical');
    const sent = await request(app, { method: 'POST', path: '/seek-permissions/1/comments', headers: requester,
      body: { body: 'Please check this advance.', client_id: randomUUID() } });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.comment.author_id, 5);
    assert.equal(sent.body.comment_count, 1);
    const history = await request(app, { path: '/seek-permissions/1/comments?after_id=0', headers: requester });
    assert.equal(history.status, 200);
    assert.equal(history.body.comments[0].body, 'Please check this advance.');
    assert.equal((await request(app, { path: '/seek-permissions/1/comments', headers: auth({ id: 6, role: 'sub_admin' }) })).status, 404);
    assert.equal((await request(app, { path: '/seek-permissions/1', headers: auth({ id: 7, role: 'employee' }) })).status, 403);
    await db.exec('UPDATE users SET token_version = 1 WHERE id = 5');
    assert.equal((await request(app, { path: '/seek-permissions/1', headers: requester })).status, 401);
  } finally {
    pool.query = originalQuery;
    await db.close();
  }
});

test('preview checks base schema before module migrations and restricts HTTP/socket origins to loopback', async () => {
  const db = new PGlite();
  try {
    await assert.rejects(assertSeekPreviewBaseSchema(db), { code: 'SEEK_PREVIEW_BASE_SCHEMA_MISSING' });
    let migrations = 0;
    await assert.rejects(startSeekPermissionPreview({ database: db, migrate: async () => { migrations++; } }),
      { code: 'SEEK_PREVIEW_BASE_SCHEMA_MISSING' });
    assert.equal(migrations, 0, 'no schema writes happen when base tables are absent');
    await db.exec(`CREATE TABLE app_schema_migrations(version text); CREATE TABLE sites(id int PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY); ${requestsSql} ${targetsSql}`);
    assert.equal((await assertSeekPreviewBaseSchema(db)).requests, true);
    for (const origin of ['http://localhost:5174', 'http://127.0.0.1:5174', undefined]) assert.equal(isSeekPreviewOrigin(origin), true);
    for (const origin of ['http://localhost:5175', 'https://evil.example', 'http://127.0.0.1:5174.evil.example']) assert.equal(isSeekPreviewOrigin(origin), false);
    let socketOptions;
    const preview = createSeekPermissionPreviewServer({ socketInitializer: (_server, options) => { socketOptions = options; return {}; } });
    assert.equal(preview.server.listening, false);
    socketOptions.allowRequest({ headers: { origin: 'https://evil.example' } }, (_error, allowed) => assert.equal(allowed, false));
    socketOptions.allowRequest({ headers: { origin: 'http://localhost:5174' } }, (_error, allowed) => assert.equal(allowed, true));
    assert.equal(seekPreviewPort('8006'), 8006);
    for (const port of [0, 65536, 'NaN', '8006oops']) assert.throws(() => seekPreviewPort(port));
  } finally { await db.close(); }
});
