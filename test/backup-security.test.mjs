import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBackupAdminGuard } from '../src/middlewares/backupAdmin.middleware.js';
import maintenance, { beginBackupRestore,endBackupRestore } from '../src/middlewares/backupMaintenance.middleware.js';

function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.status = code => { res.statusCode=code; return res; };
  res.json = data => { res.data=data; return res; };
  res.setHeader = (key,value) => { res.headers[key]=value; };
  return res;
}

test('administrators have backup access and stale roles or inactive accounts fail closed',async () => {
  for (const [tokenRole,dbRole,active,allowed] of [
    ['super_admin','super_admin',true,true], ['admin','admin',true,true],
    ['sub_admin','sub_admin',true,false], ['super_admin','admin',true,false],
    ['super_admin','super_admin',false,false], ['admin','super_admin',true,false],
  ]) {
    const db = { query:async (query,values) => {
      if (query.includes('user_permissions')) { assert.deepEqual(values,[73,'backups']);return {rows:[]}; }
      assert.deepEqual(values,[73]); return { rows:[{ role:dbRole,is_active:active }] };
    } };
    const res=response(); let next=false;
    await createBackupAdminGuard(db)({ user:{ id:73,role:tokenRole } },res,() => { next=true; });
    assert.equal(next,allowed);
    if (allowed) assert.equal(res.headers['Cache-Control'],'no-store');
    else assert.equal(res.statusCode,403);
  }
});

test('delegated backup access is opt-in and restoration needs both View and Restore',async () => {
  for (const [permission,action,allowed] of [
    [undefined,'read',false], [{can_read:false,can_restore:false},'read',false],
    [{can_read:true,can_restore:false},'read',true], [{can_read:true,can_restore:false},'restore',false],
    [{can_read:true,can_restore:true},'restore',true], [{can_read:false,can_restore:true},'restore',false],
    [{can_read:'true',can_restore:true},'read',false], [{can_read:true,can_restore:'true'},'restore',false],
  ]) {
    const db={ query:async(query,values)=>{
      if(query.includes('user_permissions')) { assert.deepEqual(values,[73,'backups']);return {rows:permission ? [permission] : []}; }
      return {rows:[{role:'sub_admin',is_active:true}]};
    }};
    const res=response();let next=false;
    await createBackupAdminGuard(db,action)({user:{id:73,role:'sub_admin'}},res,()=>{next=true;});
    assert.equal(next,allowed);
    if(!allowed) assert.equal(res.statusCode,403);
  }
});

test('grant revocation applies on the next request and unsupported roles cannot use grants',async () => {
  let permission={can_read:true,can_restore:true};
  const db={query:async query=>({rows:query.includes('user_permissions') ? [permission] : [{role:'sub_admin',is_active:true}]})};
  const guard=createBackupAdminGuard(db,'restore');
  let calls=0;
  await guard({user:{id:73,role:'sub_admin'}},response(),()=>{calls++;});
  permission={can_read:true,can_restore:false};
  const res=response();await guard({user:{id:73,role:'sub_admin'}},res,()=>{calls++;});
  assert.equal(calls,1);assert.equal(res.statusCode,403);
  const otherDb={query:async()=>({rows:[{role:'member',is_active:true}]})};
  const member=response();await createBackupAdminGuard(otherDb)({user:{id:1,role:'member'}},member,()=>assert.fail('unmanaged role'));
  assert.equal(member.statusCode,403);
});

test('missing identity and database failures fail closed before upload handling',async () => {
  const res=response(); let calls=0;
  const guard=createBackupAdminGuard({ query:async () => { calls++; throw new Error('offline'); } });
  await guard({},res,()=>assert.fail('unauthenticated'));
  assert.equal(res.statusCode,401); assert.equal(calls,0);
  let error;
  await guard({user:{id:1,role:'super_admin'}},response(),failure=>{error=failure;});
  assert.equal(error.message,'offline');
});

test('maintenance blocks business/GraphQL writes and permits backups/login; active login prevents restore',() => {
  const original=process.env.BACKUP_MAINTENANCE_MODE;
  process.env.BACKUP_MAINTENANCE_MODE='true';
  try {
    for (const path of ['/expenses','/sites','/graphql','/auth/register','/auth/profile']) {
      const res=response();maintenance({path,method:'POST'},res,()=>assert.fail(path));
      assert.equal(res.statusCode,503);
    }
    let allowed=false;maintenance({path:'/backups/preview',method:'POST'},response(),()=>{allowed=true;});assert.ok(allowed);
    const login=response();maintenance({path:'/auth/login',method:'POST'},login,()=>{});
    assert.equal(beginBackupRestore(),false);
    login.emit('finish'); login.emit('close');
    assert.equal(beginBackupRestore(),true);
    const blocked=response();maintenance({path:'/auth/login',method:'POST'},blocked,()=>assert.fail('login during restore'));
    assert.equal(blocked.data.code,'BACKUP_RESTORE_RUNNING');
    assert.equal(beginBackupRestore(),false);
    endBackupRestore();
    assert.equal(beginBackupRestore(),true); // finish+close released the counter only once
  } finally {
    endBackupRestore();
    if(original===undefined)delete process.env.BACKUP_MAINTENANCE_MODE;else process.env.BACKUP_MAINTENANCE_MODE=original;
  }
});

test('normal operation is unchanged when maintenance is disabled',() => {
  const original=process.env.BACKUP_MAINTENANCE_MODE;delete process.env.BACKUP_MAINTENANCE_MODE;
  try { let allowed=false;maintenance({path:'/expenses',method:'POST'},response(),()=>{allowed=true;});assert.ok(allowed); }
  finally { if(original!==undefined)process.env.BACKUP_MAINTENANCE_MODE=original; }
});
