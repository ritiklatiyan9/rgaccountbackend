import assert from 'node:assert/strict';
import test from 'node:test';
import permissionModel from '../src/models/Permission.model.js';
import { requireImprestReadAccess, hasImprestManagementScope } from '../src/middlewares/imprestPermission.middleware.js';

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
