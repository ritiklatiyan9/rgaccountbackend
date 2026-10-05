import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { up } from '../src/migrations/193_data_storage.js';
import { createDataStorageService, MAX_STORAGE_FILE_BYTES } from '../src/services/dataStorage.service.js';
import { createDataStorageRouter } from '../src/routes/dataStorage.routes.js';
import requirePermission from '../src/middlewares/permission.middleware.js';
import { attachmentReferences, validLocalKey } from '../src/services/backupAttachments.js';
import { moduleForTable } from '../src/services/backupModules.js';

const admin = { id: 1, role: 'admin', organization_id: 1 };
const subAdmin = { id: 2, role: 'sub_admin', organization_id: 1 };
const sampleFile = (name = 'data.txt', contents = 'Stored file content') => ({ originalname: name, mimetype: 'text/plain', buffer: Buffer.from(contents) });

async function fixture(t) {
  const sql = new PGlite();
  t.after(() => sql.close());
  await sql.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY, organization_id INTEGER NOT NULL);
    CREATE TABLE users(id INTEGER PRIMARY KEY);
    CREATE TABLE user_sites(user_id INTEGER, site_id INTEGER);
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    INSERT INTO users VALUES(1),(2);
    INSERT INTO user_sites VALUES(2,1);`);
  const query = async (text, values) => { const result = await sql.query(text, values); return { ...result, rowCount: result.affectedRows }; };
  const database = { query, connect: async () => ({ query, release() {} }) };
  await up(database);
  await up(database);
  const stored = new Map();
  const removed = [];
  let counter = 0;
  const files = {
    async upload(buffer) { const key = `test-${++counter}`; stored.set(key, Buffer.from(buffer)); return key; },
    async open(key) { return Readable.from(stored.get(key)); },
    async remove(key) { removed.push(key); stored.delete(key); },
  };
  return { database, files, stored, removed, service: createDataStorageService(database, files) };
}

test('nested folders, breadcrumbs, root uploads and downloads persist across service instances', async (t) => {
  const { service, database, files } = await fixture(t);
  const root = await service.createFolder(admin, { site_id: 1, name: 'Documents' });
  const child = await service.createFolder(admin, { site_id: 1, parent_id: root.id, name: '2026' });
  const grandchild = await service.createFolder(admin, { site_id: 1, parent_id: child.id, name: 'October' });
  const uploaded = await service.upload(admin, { site_id: 1, parent_id: grandchild.id }, sampleFile('खाता.txt'));
  assert.ok(!Object.hasOwn(uploaded, 'storage_key'));
  await service.upload(admin, { site_id: 1 }, sampleFile('root.zip', 'zip bytes'));
  const restarted = createDataStorageService(database, files);
  const listing = await restarted.list(admin, { site_id: 1, parent_id: grandchild.id });
  assert.deepEqual(listing.breadcrumbs.map((item) => item.name), ['Documents', '2026', 'October']);
  assert.equal(listing.entries[0].name, 'खाता.txt');
  assert.equal(listing.total, 1);
  assert.deepEqual(listing.stats, { folders: 3, files: 2, bytes: String(Buffer.byteLength('Stored file contentzip bytes')) });
  assert.equal((await restarted.list(admin, { site_id: 1 })).entries.length, 2);
  const download = await restarted.download(admin, 1, uploaded.id);
  let bytes = '';
  for await (const chunk of download.stream) bytes += chunk.toString();
  assert.equal(bytes, 'Stored file content');
});

test('site and organisation isolation apply to every operation and breadcrumbs', async (t) => {
  const { service, stored } = await fixture(t);
  const folder = await service.createFolder(admin, { site_id: 2, name: 'Private' });
  const uploaded = await service.upload(admin, { site_id: 2, parent_id: folder.id }, sampleFile());
  const denied = (operation, statusCode) => assert.rejects(operation, { statusCode });
  await denied(service.list(subAdmin, { site_id: 2 }), 403);
  await denied(service.createFolder(subAdmin, { site_id: 2, name: 'Denied' }), 403);
  await denied(service.upload(subAdmin, { site_id: 2 }, sampleFile()), 403);
  await denied(service.list(subAdmin, { site_id: 1, parent_id: folder.id }), 404);
  await denied(service.createFolder(admin, { site_id: 1, parent_id: folder.id, name: 'Cross-site' }), 404);
  await denied(service.upload(admin, { site_id: 1, parent_id: folder.id }, sampleFile()), 404);
  for (const user of [admin, subAdmin]) {
    await denied(service.download(user, 1, uploaded.id), 404);
    await denied(service.rename(user, 1, uploaded.id, { name: 'Changed' }), 404);
    await denied(service.remove(user, 1, folder.id), 404);
    await denied(service.list(user, { site_id: 3 }), 404);
  }
  assert.equal(stored.size, 1);
  await service.list({ ...admin, role: 'super_admin' }, { site_id: 3 });
});

test('duplicate names are rejected and failed uploads clean up their stored bytes', async (t) => {
  const { service, stored, removed } = await fixture(t);
  const root = await service.createFolder(admin, { site_id: 1, name: 'Reports' });
  await assert.rejects(service.createFolder(admin, { site_id: 1, name: 'reports' }), { statusCode: 409 });
  await service.createFolder(admin, { site_id: 1, parent_id: root.id, name: 'Reports' });
  await service.upload(admin, { site_id: 1 }, sampleFile('data.txt'));
  await assert.rejects(service.upload(admin, { site_id: 1 }, sampleFile('DATA.TXT')), { statusCode: 409 });
  assert.equal(stored.size, 1);
  assert.equal(removed.length, 1);
  await assert.rejects(service.upload(admin, { site_id: 1 }, sampleFile('Reports')), { statusCode: 409 });
  assert.equal(stored.size, 1);
});

test('rename, safe empty-folder deletion and file deletion update persistent data', async (t) => {
  const { service, stored } = await fixture(t);
  const parent = await service.createFolder(admin, { site_id: 1, name: 'Parent' });
  const child = await service.createFolder(admin, { site_id: 1, parent_id: parent.id, name: 'Child' });
  const file = await service.upload(admin, { site_id: 1, parent_id: child.id }, sampleFile());
  await assert.rejects(service.remove(admin, 1, parent.id), { statusCode: 409 });
  await assert.rejects(service.remove(admin, 1, child.id), { statusCode: 409 });
  const renamed = await service.rename(admin, 1, parent.id, { name: 'Renamed' });
  assert.equal(renamed.name, 'Renamed');
  assert.equal((await service.list(admin, { site_id: 1, parent_id: child.id })).breadcrumbs[0].name, 'Renamed');
  await service.rename(admin, 1, file.id, { name: 'renamed.txt' });
  assert.equal((await service.download(admin, 1, file.id)).name, 'renamed.txt');
  await service.remove(admin, 1, file.id);
  assert.equal(stored.size, 0);
  await service.remove(admin, 1, child.id);
  await service.remove(admin, 1, parent.id);
  assert.equal((await service.list(admin, { site_id: 1 })).total, 0);
});

test('search treats wildcards literally, lists folders first and paginates', async (t) => {
  const { service, database } = await fixture(t);
  await service.upload(admin, { site_id: 1 }, sampleFile('100%.csv'));
  await service.upload(admin, { site_id: 1 }, sampleFile('1000.csv'));
  const folder = await service.createFolder(admin, { site_id: 1, name: 'Z folder' });
  assert.equal((await service.list(admin, { site_id: 1 })).entries[0].id, folder.id);
  assert.deepEqual((await service.list(admin, { site_id: 1, q: '%' })).entries.map((item) => item.name), ['100%.csv']);
  await database.query(`INSERT INTO data_storage_entries(site_id,kind,name,created_by)
    SELECT 1,'folder','Folder ' || generate_series(1,105),1`);
  const first = await service.list(admin, { site_id: 1 });
  const second = await service.list(admin, { site_id: 1, offset: 100 });
  assert.equal(first.total, 108);
  assert.equal(first.entries.length, 100);
  assert.equal(second.entries.length, 8);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 108);
});

test('validates names, identifiers, file parents, missing uploads and oversize files', async (t) => {
  const { service, stored } = await fixture(t);
  for (const name of ['', '../bad', 'folder/name', 'folder\\name', '.', '..', 'a\nname', 'a'.repeat(256)]) {
    await assert.rejects(service.createFolder(admin, { site_id: 1, name }), { statusCode: 400 });
  }
  for (const site_id of ['', '1x', '1.5', -1, '9007199254740992']) {
    await assert.rejects(service.list(admin, { site_id }), { statusCode: 400 });
  }
  const file = await service.upload(admin, { site_id: 1 }, sampleFile());
  await assert.rejects(service.createFolder(admin, { site_id: 1, parent_id: file.id, name: 'Inside file' }), { statusCode: 404 });
  await assert.rejects(service.upload(admin, { site_id: 1 }), { statusCode: 400 });
  await assert.rejects(service.upload(admin, { site_id: 1 }, { ...sampleFile(), buffer: Buffer.alloc(MAX_STORAGE_FILE_BYTES + 1) }), { statusCode: 413 });
  assert.equal(stored.size, 1);
});

test('schema enforces cross-site parent restrictions and migration preserves existing entries', async (t) => {
  const { service, database } = await fixture(t);
  const folder = await service.createFolder(admin, { site_id: 1, name: 'Keep me' });
  await assert.rejects(database.query(`INSERT INTO data_storage_entries(site_id,parent_id,kind,name)
    VALUES(2,$1,'folder','Illegal child')`, [folder.id]), { code: '23503' });
  await up(database);
  assert.equal((await service.list(admin, { site_id: 1 })).entries[0].name, 'Keep me');
});

test('Data Storage files are included in existing backup discovery', () => {
  const localName = '11111111-1111-4111-8111-111111111111';
  const refs = attachmentReferences([{ name: 'data_storage_entries', rows: [
    { storage_key: `local::${localName}` }, { storage_key: 'data_storage/1/uploaded-file' },
  ] }], { env: { AWS_S3_BUCKET_NAME: 'test-bucket' } });
  assert.deepEqual(refs.files.map((file) => file.key), [`data_storage/${localName}`, 'data_storage/1/uploaded-file']);
  assert.ok(validLocalKey(refs.files[0].key));
  assert.equal(validLocalKey('data_storage/../escape'), false);
  assert.equal(moduleForTable('data_storage_entries'), 'spreadsheets');
});

test('HTTP API enforces authentication and each action permission, accepts multipart files and streams downloads', async (t) => {
  const { database, files } = await fixture(t);
  const app = express();
  app.use(express.json());
  app.use('/data-storage', createDataStorageRouter({
    database, files,
    authenticate(req, res, next) {
      const actor = req.get('x-test-actor');
      if (!actor) return res.status(401).json({ message: 'Authentication required' });
      const canWrite = actor === 'editor';
      req.user = actor === 'admin' ? admin : { ...subAdmin, permissionsByModule: new Map([['data_storage', {
        can_read: actor !== 'denied', can_write: canWrite, can_update: canWrite, can_delete: canWrite,
      }]]) };
      next();
    },
    permission: requirePermission,
  }));
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/data-storage`;
  const request = (url, options = {}, actor = 'admin') => fetch(base + url, { ...options, headers: { ...(actor ? { 'x-test-actor': actor } : {}), ...options.headers } });
  const jsonBody = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('?site_id=1', {}, null)).status, 401);
  assert.equal((await request('?site_id=1', {}, 'denied')).status, 403);
  const folderResult = await request('/folders', { method: 'POST', ...jsonBody({ site_id: 1, name: 'HTTP folder' }) }, 'editor');
  assert.equal(folderResult.status, 201);
  const folder = (await folderResult.json()).entry;
  const body = new FormData();
  body.set('site_id', '1');
  body.set('parent_id', String(folder.id));
  body.set('file', new Blob(['<script>test</script>'], { type: 'text/html' }), 'data.html');
  const uploaded = await request('/files', { method: 'POST', body }, 'editor');
  assert.equal(uploaded.status, 201);
  const file = (await uploaded.json()).entry;
  const download = await request(`/${file.id}/download?site_id=1`, {}, 'viewer');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await download.text(), '<script>test</script>');
  for (const [url, method, payload] of [
    ['/folders', 'POST', { site_id: 1, name: 'Forbidden' }],
    [`/${file.id}?site_id=1`, 'PATCH', { name: 'Forbidden' }],
    [`/${file.id}?site_id=1`, 'DELETE', {}],
  ]) assert.equal((await request(url, { method, ...jsonBody(payload) }, 'viewer')).status, 403);
  assert.equal((await request('/files', { method: 'POST', body }, 'viewer')).status, 403);
  assert.equal((await request('?site_id=2', {}, 'editor')).status, 403);
  assert.equal((await request(`/${file.id}/download?site_id=2`)).status, 404);
  const oversized = new FormData();
  oversized.set('site_id', '1');
  oversized.set('file', new Blob([Buffer.alloc(MAX_STORAGE_FILE_BYTES + 1)]), 'large.bin');
  assert.equal((await request('/files', { method: 'POST', body: oversized })).status, 413);
});
