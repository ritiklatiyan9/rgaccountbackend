import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql } from '../src/migrations/249_native_backups.js';
import { createNativeBackupJobs } from '../src/services/nativeBackupJobs.js';
import { createNativeBackupRouter } from '../src/routes/nativeBackup.routes.js';
import { up as installBackups } from '../src/migrations/249_native_backups.js';

test('backup page reports incomplete setup safely and recovers after its metadata migration', { skip: process.env.BACKUP_NATIVE_HTTP_TEST !== 'true' }, async t => {
  const engine = new PGlite(); t.after(() => engine.close());
  await engine.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active BOOLEAN); INSERT INTO users VALUES(1,'admin',true)");
  const query = async (sql, values) => values ? engine.query(sql, values) : (await engine.exec(sql)).at(-1) || { rows: [] };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const config = { enabled: true, retentionDays: 30 }; let online = true;
  const app = express(); app.use(express.json());
  app.use('/backups', createNativeBackupRouter({ db, config, workerReady: async () => online, authenticate: (req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/backups/jobs`;
  const before = await fetch(url);
  assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'no-store');
  const setup = await before.json();
  assert.equal(setup.readiness.code, 'BACKUP_SCHEMA_REQUIRED');
  assert.equal(setup.capabilities.enabled, false); assert.equal(setup.historyAvailable, false);
  const create = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"scope":"database"}' });
  assert.equal(create.status, 503); assert.equal((await create.json()).code, 'BACKUP_SCHEMA_REQUIRED');
  await installBackups(db);
  const installed = await (await fetch(url)).json();
  assert.equal(installed.readiness.status, 'ready'); assert.equal(installed.historyAvailable, true);
  online = false;
  const restarting = await (await fetch(url)).json();
  assert.equal(restarting.readiness.status, 'worker-unavailable'); assert.equal(restarting.capabilities.enabled, false);
  assert.equal(restarting.worker.online, false);
  config.enabled = false;
  const disabled = await (await fetch(url)).json();
  assert.equal(disabled.readiness.code, 'BACKUP_NOT_CONFIGURED'); assert.equal(disabled.capabilities.enabled, false);
});

test('native backup HTTP routes preserve live authorization, validate scopes, audit downloads and protect isolated restore', { skip: process.env.BACKUP_NATIVE_HTTP_TEST !== 'true' }, async t => {
  const engine = new PGlite();
  t.after(() => engine.close());
  await engine.exec(migrationSql);
  await engine.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active BOOLEAN);
    INSERT INTO users VALUES(1,'admin',true),(2,'sub_admin',true),(3,'member',true);
    CREATE TABLE user_permissions(user_id INTEGER,module TEXT,can_read BOOLEAN,can_restore BOOLEAN);
    INSERT INTO user_permissions VALUES(2,'backups',true,false);`);
  const query = (sql, params) => engine.query(sql, params);
  const db = { query, connect: async () => ({ query,release() {} }) };
  const config = { enabled: true, filesEnabled: true, retentionDays: 30, maxAttempts: 2,
    restoreDatabaseUrl: 'postgresql://fixture@localhost/backup_verify_test', prefix: 'test-backups' };
  const jobs = createNativeBackupJobs(db,config);
  const signedKeys = [];
  const storage = { presign: async job => { signedKeys.push(job.artifactKey); return { url:'https://private.example/fixture?signature=DO_NOT_AUDIT',filename:'backup.dump',expiresAt:new Date(Date.now()+60000).toISOString() }; } };
  const app = express();
  app.use(express.json());
  app.use('/backups',createNativeBackupRouter({ db, config, storage, workerReady: async () => true, authenticate: (req,_res,next) => {
    const id = Number(req.headers['x-test-user']);
    if (id) req.user = { id,role: req.headers['x-test-role'] || ({1:'admin',2:'sub_admin',3:'member'})[id] };
    next();
  } }));
  const server = app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject) => { server.once('listening',resolve);server.once('error',reject); });
  t.after(() => new Promise(resolve => {server.closeAllConnections();server.close(resolve);}));
  const base = `http://127.0.0.1:${server.address().port}/backups`;
  const request = async (method,path,{user=1,body,role}={}) => {
    const response = await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json',...(user?{'x-test-user':String(user)}:{}),...(role?{'x-test-role':role}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return { status:response.status,headers:response.headers,body:await response.json() };
  };
  assert.equal((await request('GET','/jobs',{user:null})).status,401);
  assert.equal((await request('GET','/jobs',{user:3})).status,403);
  assert.equal((await request('GET','/jobs',{user:1,role:'super_admin'})).status,403);
  const listing = await request('GET','/jobs',{user:2});
  assert.equal(listing.status,200);
  assert.equal(listing.headers.get('cache-control'),'no-store');
  assert.equal(listing.body.capabilities.enabled,true);
  const maintenanceBefore=process.env.BACKUP_MAINTENANCE_MODE;
  try {
    process.env.BACKUP_MAINTENANCE_MODE='true';
    assert.equal((await request('POST','/jobs',{body:{scope:'database'}})).status,409);
  } finally {
    if(maintenanceBefore===undefined)delete process.env.BACKUP_MAINTENANCE_MODE;else process.env.BACKUP_MAINTENANCE_MODE=maintenanceBefore;
  }
  assert.equal((await request('POST','/jobs',{body:{scope:'database',shell:'rm -rf'}})).status,400);
  const created = await request('POST','/jobs',{body:{scope:'database-files'}});
  assert.equal(created.status,202);
  assert.equal(created.body.status,'queued');
  const id = created.body.id;
  assert.equal((await request('POST','/jobs',{body:{scope:'database'}})).status,409);
  assert.equal((await request('POST',`/jobs/${id}/download`)).status,409);
  const running = await jobs.claim('api-fixture');
  await jobs.complete(id,running.leaseToken,{bytes:3,checksum:'a'.repeat(64),verificationStatus:'verified',artifactKey:`${running.artifactPrefix}database.dump`,manifestKey:`${running.artifactPrefix}manifest.json`,fileCount:1});
  const fileId = 'b'.repeat(64);
  await query("UPDATE backup_control.jobs SET expires_at=now()-interval '1 day' WHERE id=$1",[id]);
  await query('INSERT INTO backup_control.files(job_id,attempt,file_id,metadata) VALUES($1,$2,$3,$4::jsonb)',[id,running.attempt,fileId,JSON.stringify({artifactKey:`${running.artifactPrefix}files/${fileId}`,checksum:'c'.repeat(64),bytes:8})]);
  assert.equal((await request('POST',`/jobs/${id}/download`,{body:{artifact:'file',fileId:'../escape'}})).status,400);
  for (const artifact of ['database','manifest','files-manifest','file']) {
    const download = await request('POST',`/jobs/${id}/download`,{body:{artifact,...(artifact==='file'?{fileId}:{})}});
    assert.equal(download.status,200);
    assert.match(download.body.url,/signature=/);
  }
  assert.equal(signedKeys.length,4);
  assert.ok(signedKeys.every(key => key.startsWith(running.artifactPrefix)));
  const audit = (await query("SELECT details FROM backup_control.events WHERE action='download-authorized'")).rows;
  assert.equal(audit.length,4);
  assert.doesNotMatch(JSON.stringify(audit),/signature|DO_NOT_AUDIT/);
  assert.equal((await request('POST',`/jobs/${id}/restore-test`,{user:2,body:{confirmation:'VERIFY RESTORE'}})).status,403);
  assert.equal((await request('POST',`/jobs/${id}/restore-test`,{body:{confirmation:'RESTORE'}})).status,400);
  assert.equal((await request('POST',`/jobs/${id}/restore-test`,{body:{confirmation:'VERIFY RESTORE',databaseUrl:'postgresql://production'}})).status,400);
  const restore = await request('POST',`/jobs/${id}/restore-test`,{body:{confirmation:'VERIFY RESTORE'}});
  assert.equal(restore.status,202);
  assert.equal(restore.body.kind,'restore-test');
  await jobs.cancel(restore.body.id,1);
  assert.equal((await request('POST',`/jobs/${restore.body.id}/retry`,{user:2})).status,409);
  await query('UPDATE user_permissions SET can_read=false WHERE user_id=2');
  assert.equal((await request('POST',`/jobs/${id}/download`,{user:2})).status,403);
  const publicJob = (await request('GET',`/jobs/${id}`)).body;
  assert.equal('artifactKey' in publicJob,false);
  assert.equal('leaseToken' in publicJob,false);
});
