import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import pool from '../src/config/db.js';
import { excelUploadAllowed, listCaWorkflowUsers, setCaWorkflowUser, requireExcelUpload } from '../src/services/caWorkflow.service.js';
import { importCatalog, prepareExcelImport, validateImportRow } from '../src/services/caExcelImport.service.js';
import { CA_EXCEL_MODULES } from '../src/services/caExcelModules.js';
import { routeExcelImport } from '../src/controllers/caWorkflow.controller.js';
import { createCaWorkflowPreviewApp } from '../src/preview/caWorkflowPreview.js';

const admin = { id: 1, role: 'admin', organization_id: 1 };
const user = { id: 2, role: 'sub_admin', organization_id: 1 };
test('CA Workflow grants, revocation, organisation isolation and import routing', async t => {
  const db = new PGlite();
  t.mock.method(pool, 'query', (sql, args) => db.query(sql, args));
  let server;
  try {
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,is_active boolean DEFAULT true,organization_id int);
      INSERT INTO users VALUES(1,'Admin','admin',true,1),(2,'CA','sub_admin',true,1),(3,'Other org','sub_admin',true,2),(4,'Inactive','sub_admin',false,1);
      CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb,updated_by int,updated_at timestamptz);
      CREATE UNIQUE INDEX global_settings_key ON application_settings(setting_key) WHERE site_id IS NULL;
      CREATE TABLE sites(id int PRIMARY KEY,organization_id int); INSERT INTO sites VALUES(10,1),(11,1),(20,2);
      CREATE TABLE user_sites(user_id int,site_id int); INSERT INTO user_sites VALUES(2,10);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean DEFAULT false,can_write boolean DEFAULT false,can_update boolean DEFAULT false,can_delete boolean DEFAULT false,can_restore boolean DEFAULT false,can_view_all boolean DEFAULT false,updated_at timestamptz,UNIQUE(user_id,module));
      INSERT INTO user_permissions(user_id,module,can_read,can_write) VALUES(2,'expenses',true,true),(2,'farmers',true,false);
      CREATE TABLE firms(id int,site_id int);INSERT INTO firms VALUES(100,10),(101,11);
      CREATE TABLE farmers(id int,site_id int);INSERT INTO farmers VALUES(100,10),(101,11);`);
    await t.test('default denied; only same-organisation active sub-admins can be enabled', async () => {
      assert.equal(await excelUploadAllowed(user, db), false);
      assert.equal(await excelUploadAllowed(admin, db), true);
      assert.deepEqual((await listCaWorkflowUsers(admin, db)).map(row => row.id), [1,2]);
      await assert.rejects(listCaWorkflowUsers(user, db), error => error.statusCode === 403);
      for (const id of [1,3,4,999]) await assert.rejects(setCaWorkflowUser(admin,id,true,db), error => error.statusCode === 404);
      for (const id of ['2x',0,-1]) await assert.rejects(setCaWorkflowUser(admin,id,true,db));
      await assert.rejects(setCaWorkflowUser(admin,2,'true',db));
      await assert.rejects(setCaWorkflowUser(user,2,true,db), error => error.statusCode === 403);
      await setCaWorkflowUser(admin,2,true,db);
      assert.equal(await excelUploadAllowed(user, db), true);
      assert.equal(await excelUploadAllowed({...user,organization_id:2}, db), false);
      const grant = (await db.query("SELECT * FROM user_permissions WHERE user_id=2 AND module='farmers'")).rows[0];
      assert.equal(grant.can_write, false);
    });
    await t.test('catalogue and writes require module and site rights; callers cannot select arbitrary routes or fields', async () => {
      const catalog = await importCatalog(user,10,db);
      assert.ok(catalog.some(spec => spec.key === 'expenses'));
      assert.ok(!catalog.some(spec => spec.key === 'farmers'));
      await assert.rejects(importCatalog(user,11,db), error => error.statusCode === 403);
      await assert.rejects(importCatalog(admin,20,db), error => error.statusCode === 403);
      await assert.rejects(prepareExcelImport(user,{module:'farmers',site_id:10,row:{name:'Test'}},db), error => error.statusCode === 403);
      await assert.rejects(prepareExcelImport(admin,{module:'/admin/users',site_id:10,row:{}},db));
      const envelope = {module:'expenses',site_id:10,row:{date:'2026-11-05',debit:100,payment_mode:'cash'}};
      assert.deepEqual(await prepareExcelImport(user,envelope,db),{target:'/expenses',body:{date:'2026-11-05',debit:100,payment_mode:'CASH',site_id:10}});
      await assert.rejects(prepareExcelImport(user,{...envelope,row:{...envelope.row,status:'approved'}},db));
      await assert.rejects(prepareExcelImport(user,{...envelope,row:{...envelope.row,site_id:20}},db));
      const firm = {module:'firm_transactions',site_id:10,row:{firm_id:101,description:'Test',date:'2026-11-05',debit:100,payment_mode:'BANK'}};
      await assert.rejects(prepareExcelImport(admin,firm,db), error => error.statusCode === 403);
      firm.row.firm_id=100;assert.equal((await prepareExcelImport(admin,firm,db)).target,'/firms/transactions');
      const farmer = {module:'farmer_payments',site_id:10,row:{farmer_id:100,particular:'CASH',amount:100,date:'2026-11-05',payment_mode:'CASH'}};
      const payment = await prepareExcelImport(admin,farmer,db);
      assert.equal(payment.target,'/farmers/100/payments');assert.equal(Object.hasOwn(payment.body,'farmer_id'),false);
    });
    await t.test('ordinary create middleware executes after the import gate', async () => {
      const app = express(), router=express.Router();
      app.use(express.json());
      router.post('/ca-excel-import',(req,_res,next)=>{req.user=user;next();},routeExcelImport);
      router.post('/expenses',(req,res)=>res.status(403).json({ordinaryModuleGuard:true,site:req.body.site_id,policyPath:req.originalUrl}));
      app.use(router);app.use((error,_req,res,_next)=>res.status(error.statusCode||500).json({message:error.message}));
      server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
      const response=await fetch(`http://127.0.0.1:${server.address().port}/ca-excel-import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({module:'expenses',site_id:10,row:{date:'2026-11-05',debit:100,payment_mode:'CASH'}})});
      assert.equal(response.status,403);assert.deepEqual(await response.json(),{ordinaryModuleGuard:true,site:10,policyPath:'/expenses'});
      await new Promise(resolve=>server.close(resolve));server=null;
    });
    await t.test('local bridge uses only a validated fixed create target', async () => {
      const calls=[];
      const app=createCaWorkflowPreviewApp({authenticate:(req,_res,next)=>{req.user=user;next();},request:async(url,options)=>{calls.push({url,options});return {status:201,json:async()=>({expense:{id:12}})};}});
      server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
      const send=body=>fetch(`http://127.0.0.1:${server.address().port}/ca-excel-import`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test','X-Session-ID':'7'},body:JSON.stringify(body)});
      const response=await send({module:'expenses',site_id:10,row:{date:'2026-11-05',debit:100,payment_mode:'CASH'}});
      assert.equal(response.status,201);assert.equal(calls[0].url,'https://rgaccountbackend.onrender.com/expenses');
      assert.equal(JSON.parse(calls[0].options.body).site_id,10);
      await setCaWorkflowUser(admin,2,false,db);
      assert.equal((await send({module:'expenses',site_id:10,row:{date:'2026-11-05',debit:100,payment_mode:'CASH'}})).status,403);
      assert.equal(calls.length,1);
      let advanced=false;
      const res={status(value){this.statusCode=value;return this;},json(value){this.body=value;}};
      await requireExcelUpload({user},res,()=>{advanced=true;});assert.equal(advanced,false);assert.equal(res.statusCode,403);
    });
  } finally { if(server) await new Promise(resolve=>server.close(resolve)); await db.close(); }
});

test('import row validation rejects invalid amounts, IDs, dates and missing fields', () => {
  const spec=CA_EXCEL_MODULES.find(spec=>spec.key==='expenses');
  const valid={date:'2026-11-05',debit:100,payment_mode:'BANK'};
  for(const changes of [{date:'2026-02-30'},{debit:-2},{debit:NaN},{debit:0},{credit:100},{payment_mode:'UNKNOWN'},{assigned_admin_id:'2x'}]) assert.throws(()=>validateImportRow(spec,{...valid,...changes}));
  for(const spec of CA_EXCEL_MODULES) {
    assert.equal(new Set(spec.fields.map(field=>field.key)).size,spec.fields.length,`unique fields: ${spec.key}`);
    assert.throws(()=>validateImportRow(spec,{}),undefined,`required fields: ${spec.key}`);
  }
});
