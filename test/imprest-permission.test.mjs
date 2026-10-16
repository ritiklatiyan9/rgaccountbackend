import assert from 'node:assert/strict';
import test from 'node:test';
import permissionModel from '../src/models/Permission.model.js';
import { requireImprestReadAccess, requireImprestBalanceAccess, hasImprestManagementScope } from '../src/middlewares/imprestPermission.middleware.js';
import { PGlite } from '@electric-sql/pglite';

test('a saved Imprest Management permission applies only to the selected sub-admin and revokes on the next request', async () => {
  const db = new PGlite();
  const original = permissionModel.getPermission;
  try {
    await db.exec(`CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_write boolean,
      can_update boolean,can_delete boolean,can_restore boolean,can_view_all boolean,updated_at timestamptz,UNIQUE(user_id,module));`);
    permissionModel.getPermission = async (id, module) => (await db.query('SELECT * FROM user_permissions WHERE user_id=$1 AND module=$2', [id, module])).rows[0];
    const check = async id => {
      const result = { status: 200, next: false };
      const req = { user: { id, role: 'sub_admin' }, query: { scope: 'management' } };
      await requireImprestReadAccess(req, { status(code) { result.status = code; return this; }, json() {} }, error => {
        if (error) throw error;
        result.next = true;
      });
      result.management = hasImprestManagementScope(req);
      return result;
    };
    assert.equal((await check(2)).status, 403);
    const saved = await permissionModel.upsert(2, 'imprest_management', { can_read: true }, db);
    assert.equal(saved.can_write, false);
    assert.equal(saved.can_update, false);
    assert.deepEqual(await check(2), { status: 200, next: true, management: true });
    assert.equal((await check(3)).status, 403);
    await permissionModel.upsert(2, 'imprest_management', { can_read: false }, db);
    assert.equal((await check(2)).status, 403);
  } finally { permissionModel.getPermission = original; await db.close(); }
});

test('Imprest read boundary requires current explicit grants and management scope', async (t) => {
  const original = permissionModel.getPermission;
  const grants = new Map();
  permissionModel.getPermission = async (_userId,module) => grants.get(module) || {can_read:false};
  const call = async (role='sub_admin',scope) => {
    const req = {user:{id:2,role},query:{scope}};
    const result = {req,next:false,status:200};
    const res = {status(code){result.status=code;return this;},json(body){result.body=body;return this;}};
    await requireImprestReadAccess(req,res,error=>{if(error)throw error;result.next=true;});
    return result;
  };
  try {
    await t.test('new Management module is opt-in and a missing grant is denied', async () => {
      assert.ok(permissionModel.constructor.ALL_MODULES.includes('imprest_management'));
      assert.equal((await call()).status,403);
      grants.set('imprest',{can_read:true});
      assert.equal((await call()).next,true);
      assert.equal((await call('sub_admin','management')).status,403);
    });
    await t.test('management-only viewers can read their assigned-site Management workspace', async () => {
      grants.set('imprest',{can_read:false});grants.set('imprest_management',{can_read:true});
      const result=await call('sub_admin','management');
      assert.equal(result.next,true);assert.equal(result.req.canReadPersonalImprest,false);
      assert.equal(hasImprestManagementScope(result.req),true);
    });
    await t.test('revocation and malformed permissions fail closed on the next request', async () => {
      grants.set('imprest_management',{can_read:'true'});
      assert.equal((await call()).status,403);
      grants.set('imprest_management',{can_read:false});
      assert.equal((await call('sub_admin','management')).status,403);
    });
    await t.test('existing administrator and super-admin access is preserved', async () => {
      for(const role of ['admin','super_admin']) assert.equal((await call(role)).next,true);
      assert.equal((await call('unknown')).status,403);
    });
  } finally {permissionModel.getPermission=original;}
});

test('financial funding access is limited to an own balance and a granted payment module', async () => {
  const original = permissionModel.getPermission;
  const queried = [];
  permissionModel.getPermission = async (_id, module) => {
    queried.push(module);
    return module === 'expenses' ? { can_write: true } : module === 'commissions' ? { can_update: true } : { can_write: false };
  };
  const call = async query => {
    const result = { status: 200, next: false };
    const req = { user: { id: 2, role: 'sub_admin' }, query: { purpose: 'cash-funding', module: 'expense', site_id: 10, ...query } };
    const res = { status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
    await requireImprestBalanceAccess(req, res, error => { if (error) throw error; result.next = true; });
    assert.equal(hasImprestManagementScope(req), false);
    return result;
  };
  try {
    assert.equal((await call({ user_id: 2 })).next, true);
    assert.equal((await call({ module: 'plot_commission' })).next, true);
    assert.deepEqual(queried.slice(0, 2), ['expenses', 'commissions']);
    assert.equal((await call({ user_id: 3 })).status, 403);
    assert.equal((await call({ scope: 'management' })).status, 403);
    assert.equal((await call({ module: 'settings' })).status, 400);
    assert.equal((await call({ module: 'cashflow' })).status, 403);
    assert.equal((await call({ purpose: undefined })).status, 403, 'funding grants do not grant normal Imprest reads');
  } finally { permissionModel.getPermission = original; }
});
