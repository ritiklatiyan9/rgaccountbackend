import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql } from '../src/migrations/229_imprest_management_visibility.js';
import { getImprestManagementSettings, saveImprestManagementSettings, visibleImprestPeople } from '../src/services/imprestManagementAccess.service.js';
import { imprestAllocationModel, imprestExpenseRequestModel, imprestReturnModel, imprestTransferModel, imprestLedgerModel } from '../src/models/Imprest.model.js';
import { getBalance, getLedger, getAllBalances } from '../src/controllers/imprest.controller.js';
import { loadImprestManagementVisibility } from '../src/middlewares/imprestManagementAccess.middleware.js';
import { requireImprestReadAccess } from '../src/middlewares/imprestPermission.middleware.js';
import pool from '../src/config/db.js';
const admin={id:1,role:'admin',organization_id:1},viewer={id:2,role:'sub_admin',organization_id:1};
const invoke=(handler,req)=>new Promise((resolve,reject)=>handler(req,{statusCode:200,status(code){this.statusCode=code;return this;},json(body){resolve({status:this.statusCode,body});}},reject));
test('Imprest settings and Management reads isolate chosen people and sites',async t=>{
  const db=new PGlite(),client={query:(sql,args)=>db.query(sql,args),release(){}},database={query:client.query,connect:async()=>client};
  t.mock.method(pool,'query',client.query);
  try{
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,email text,role text,is_active boolean DEFAULT true,organization_id int DEFAULT 1);
      INSERT INTO users(id,name,role,organization_id) VALUES(1,'Admin','admin',1),(2,'Viewer','sub_admin',1),(3,'Alice','sub_admin',1),(4,'Bob','sub_admin',1),(5,'Other site','sub_admin',1),(6,'Other org','sub_admin',2);
      CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int);INSERT INTO sites VALUES(10,'First',1),(11,'Second',1),(20,'Other org',2);
      CREATE TABLE user_sites(user_id int,site_id int,PRIMARY KEY(user_id,site_id));INSERT INTO user_sites VALUES(2,10),(3,10),(4,10),(2,11),(4,11),(5,11),(6,20);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_write boolean,can_update boolean,can_delete boolean,can_restore boolean,can_view_all boolean,updated_at timestamptz DEFAULT now(),UNIQUE(user_id,module));
      INSERT INTO user_permissions VALUES(2,'imprest',false,false,false,false,false,false,now());
      CREATE TABLE imprest_ledger(id int,user_id int,site_id int,amount numeric,created_at timestamptz DEFAULT now());INSERT INTO imprest_ledger(id,user_id,site_id,amount) VALUES(1,3,10,100),(2,4,10,900),(3,3,11,8000);
      CREATE TABLE imprest_debit_reservations(user_id int,site_id int,amount numeric,updated_at timestamptz DEFAULT now());INSERT INTO imprest_debit_reservations VALUES(3,10,20),(4,10,90);
      CREATE TABLE imprest_allocations(id int,site_id int,sub_admin_id int,admin_id int,assigned_admin_id int,created_at timestamptz DEFAULT now());INSERT INTO imprest_allocations(id,site_id,sub_admin_id,admin_id) VALUES(1,10,3,1),(2,10,4,1),(3,11,3,1);
      CREATE TABLE imprest_expense_requests(id int,site_id int,sub_admin_id int,assigned_admin_id int,reviewed_by int,status text,created_at timestamptz DEFAULT now());INSERT INTO imprest_expense_requests(id,site_id,sub_admin_id,status) VALUES(1,10,3,'PENDING'),(2,10,4,'PENDING'),(3,11,3,'PENDING');
      CREATE TABLE imprest_returns(LIKE imprest_expense_requests INCLUDING ALL);INSERT INTO imprest_returns SELECT * FROM imprest_expense_requests;
      CREATE TABLE imprest_transfers(id int,site_id int,from_user_id int,to_user_id int,initiated_by int,created_at timestamptz DEFAULT now());INSERT INTO imprest_transfers(id,site_id,from_user_id,to_user_id,initiated_by) VALUES(1,10,3,4,1),(2,10,4,2,1),(3,11,3,4,1);`);
    await db.exec(migrationSql);await db.exec(migrationSql);
    const save=(ids,enabled=true,site=10)=>saveImprestManagementSettings(database,admin,2,{site_id:site,enabled,visible_user_ids:ids});
    await t.test('only admins can select eligible same-site people; grants never add write rights',async()=>{
      assert.deepEqual((await getImprestManagementSettings(db,admin,10)).users.map(p=>p.id),[3,4,2]);
      await assert.rejects(getImprestManagementSettings(db,viewer,10),e=>e.statusCode===403);
      await assert.rejects(getImprestManagementSettings(db,admin,20),e=>e.statusCode===403);
      assert.equal((await getImprestManagementSettings(db,{...admin,role:'super_admin'},20)).people[0].id,6);
      await assert.rejects(saveImprestManagementSettings(database,viewer,2,{site_id:10,enabled:true,visible_user_ids:[3]}),e=>e.statusCode===403);
      await save([3,3]);assert.deepEqual(await visibleImprestPeople(db,viewer,10),[3]);
      const grant=(await db.query("SELECT * FROM user_permissions WHERE user_id=2 AND module='imprest_management'")).rows[0];
      assert.equal(grant.can_read,true);assert.equal(grant.can_write,false);assert.equal(grant.can_update,false);
      for(const ids of [[4,5],[6],[-1],['3x']])await assert.rejects(save(ids),e=>e.statusCode===400);
      await assert.rejects(saveImprestManagementSettings(database,admin,5,{site_id:10,enabled:true,visible_user_ids:[3]}),e=>e.statusCode===400);
      assert.deepEqual(await visibleImprestPeople(db,viewer,10),[3]);
    });
    await t.test('lists, balances and transfer counts filter before pagination',async()=>{
      for(const model of [imprestAllocationModel,imprestExpenseRequestModel,imprestReturnModel]){
        assert.deepEqual((await model.findAllWithDetails(10,db,[3])).map(r=>r.id),[1]);
        assert.deepEqual(await model.findAllWithDetails(10,db,[]),[]);assert.equal((await model.findAllWithDetails(10,db)).length,2);
      }
      for(const model of [imprestExpenseRequestModel,imprestReturnModel])assert.deepEqual((await model.findPending(10,db,[3])).map(r=>r.id),[1]);
      const balances=await imprestLedgerModel.getAllBalances(10,db,[3]);assert.deepEqual(balances.map(r=>r.user_id),[3]);assert.equal(Number(balances[0].available_balance),80);
      assert.deepEqual(await imprestLedgerModel.getAllBalances(10,db,[]),[]);
      assert.deepEqual((await imprestTransferModel.findWithDetails({siteId:10,visibleUserIds:[3],limit:1},db)).map(r=>r.id),[1]);
      assert.equal(await imprestTransferModel.count({siteId:10,visibleUserIds:[3]},db),1);assert.equal(await imprestTransferModel.count({siteId:10,visibleUserIds:[]},db),0);
    });
    await t.test('direct history and balance links cannot bypass selection, and edits/revocation apply immediately',async()=>{
      const request=()=>({user:viewer,query:{scope:'management',site_id:10,user_id:4},imprestSiteId:10,canManageImprest:true});
      const load=async()=>{const req=request();await loadImprestManagementVisibility(req,{},e=>{if(e)throw e;});return req;};
      const req=await load();assert.deepEqual(req.imprestVisibleUserIds,[3]);
      assert.equal((await invoke(getLedger,req)).status,403);assert.equal((await invoke(getBalance,req)).status,403);
      assert.deepEqual((await invoke(getAllBalances,req)).body.balances.map(r=>r.user_id),[3]);
      await save([4]);assert.deepEqual((await load()).imprestVisibleUserIds,[4]);
      await save([4],false);assert.equal((await invoke(requireImprestReadAccess,request())).status,403);
    });
    await t.test('sites never combine; removing either membership removes visibility',async()=>{
      await save([3]);await save([4],true,11);
      assert.deepEqual(await visibleImprestPeople(db,viewer,10),[3]);assert.deepEqual(await visibleImprestPeople(db,viewer,11),[4]);assert.deepEqual(await visibleImprestPeople(db,viewer,20),[]);
      await db.exec('DELETE FROM user_sites WHERE user_id=3 AND site_id=10');assert.deepEqual(await visibleImprestPeople(db,viewer,10),[]);
      await db.exec('DELETE FROM user_sites WHERE user_id=2 AND site_id=11');assert.deepEqual(await visibleImprestPeople(db,viewer,11),[]);
    });
  }finally{await db.close();}
});
