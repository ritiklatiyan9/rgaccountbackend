import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getPermissions, updatePermissions } from '../src/controllers/permission.controller.js';
import requirePermission from '../src/middlewares/permission.middleware.js';

const invoke = (handler, req) => new Promise((resolve, reject) => handler(req, {
  status(code) { this.code = code; return this; },
  json(body) { resolve({ status: this.code || 200, body }); },
}, reject));

const check = (user, module) => new Promise((resolve, reject) => {
  requirePermission(module, 'read')({ user }, {
    status(code) { this.code = code; return this; }, json() { resolve(this.code); },
  }, error => error ? reject(error) : resolve(200));
});

test('permission API round trips both overview grants and enforces revocations independently', async () => {
  const db = new PGlite();
  const originalQuery = pool.query, originalConnect = pool.connect;
  pool.query = (sql, values) => db.query(sql, values);
  pool.connect = async () => ({ query: pool.query, release() {} });
  try {
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY, role text);
      INSERT INTO users VALUES(7,'sub_admin');
      CREATE TABLE user_permissions(user_id int, module text, can_read boolean, can_write boolean,
        can_update boolean, can_delete boolean, can_restore boolean, can_view_all boolean,
        updated_at timestamp DEFAULT NOW(), UNIQUE(user_id,module));
      INSERT INTO user_permissions(user_id,module,can_read,can_write,can_view_all)
        VALUES(7,'expenses',false,false,false);`);
    const keys = ['all_sites_commission', 'all_sites_personal_ledger'];
    const user = () => ({ id: 7, role: 'sub_admin', permissionsByModule: new Map() });
    const before = await invoke(getPermissions, { params: { userId: '7' } });
    for (const key of keys) {
      assert.ok(before.body.modules.includes(key));
      assert.equal(before.body.permissions.find(row => row.module === key).can_read, false);
      assert.equal(await check(user(), key), 403);
    }
    const grant = module => ({ module, can_read: true, can_write: false, can_update: false,
      can_delete: false, can_restore: false, can_view_all: false });
    const saved = await invoke(updatePermissions, { params: { userId: '7' }, body: { permissions: keys.map(grant) } });
    assert.equal(saved.status, 200);
    for (const key of keys) {
      const row = saved.body.permissions.find(row => row.module === key);
      assert.equal(row.can_read, true);
      for (const action of ['write', 'update', 'delete', 'restore', 'view_all']) assert.equal(row[`can_${action}`], false);
      assert.equal(await check(user(), key), 200);
    }
    assert.equal(saved.body.permissions.find(row => row.module === 'expenses').can_read, false, 'unrelated existing choices survive');
    await invoke(updatePermissions, { params: { userId: '7' }, body: { permissions: [{ ...grant(keys[0]), can_read: false }] } });
    assert.equal(await check(user(), keys[0]), 403);
    assert.equal(await check(user(), keys[1]), 200);
    for (const role of ['admin', 'super_admin']) for (const key of keys) assert.equal(await check({ id: 1, role }, key), 200);
    for (const key of keys) assert.equal(await check({ id: 1, role: 'viewer' }, key), 403);
  } finally {
    pool.query = originalQuery; pool.connect = originalConnect;
    await db.close();
  }
});

test('both production portfolio endpoints check parent and overview grants before scope and cache', () => {
  for (const [file, parent, overview] of [['cashflow', 'cashflow', 'all_sites_personal_ledger'], ['plotCommissionV2', 'commissions', 'all_sites_commission']]) {
    const source = readFileSync(new URL(`../src/routes/${file}.routes.js`, import.meta.url), 'utf8');
    const route = source.split('\n').find(line => line.startsWith("router.get('/portfolio'"));
    assert.ok(route.includes("requireRole('admin', 'sub_admin')"));
    const baseCheck = route.indexOf(`requirePermission('${parent}', 'read')`);
    const overviewCheck = route.indexOf(`requirePermission('${overview}', 'read')`);
    assert.ok(baseCheck > 0 && overviewCheck > baseCheck && route.indexOf('requireOverallSiteScope') > overviewCheck);
  }
});
