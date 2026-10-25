import test from 'node:test';
import assert from 'node:assert/strict';
import { farmerPaymentModel } from '../src/models/Farmer.model.js';
import { REPORTS } from '../src/services/reportDefinitions.js';
import { withTransactionAttribution } from '../src/services/transactionAttribution.service.js';
import { transactionAttributionMiddleware } from '../src/middlewares/transactionAttribution.middleware.js';

test('financial reads resolve creator and approver names in batches without changing cached payloads or crossing sites/organizations', {skip:!process.env.PGLITE_MODULE}, async () => {
 const {PGlite}=await import(process.env.PGLITE_MODULE);const pg=new PGlite();let reads=0;
 const db={query:async (...args)=>{reads++;return pg.query(...args);}};
 try {
  await pg.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,organization_id int);INSERT INTO users VALUES(1,'Reader',1),(2,'Creator',1),(3,'Approver',1),(4,'Private user',2);
   CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(10,1),(20,2),(11,1);
   CREATE TABLE expenses(id int PRIMARY KEY,site_id int,created_by int,approved_by int);INSERT INTO expenses VALUES(12,10,2,3),(13,20,4,4),(14,11,2,3);`);
  await pg.exec(`CREATE TABLE farmers(id int PRIMARY KEY,site_id int);INSERT INTO farmers VALUES(51,10);
   CREATE TABLE farmer_payments(id int PRIMARY KEY,farmer_id int,amount numeric,created_by int,approved_by int,assigned_admin_id int,date date,created_at timestamptz);
   INSERT INTO farmer_payments VALUES(1,51,50.25,2,3,1,'2026-10-25',now());`);
  const farmerRows=await farmerPaymentModel.findByFarmerId(51,db);
  assert.equal(farmerRows[0].created_by_name,'Creator');assert.equal(farmerRows[0].approved_by_name,'Approver');
  assert.equal(farmerRows[0].assigned_admin_name,'Reader','assigned reviewer remains independent of actual approval');
  assert.equal(Number(farmerRows[0].amount),50.25);
  const creatorColumn=REPORTS.expenses.columns.find(column=>column.key==='created_by_name');
  const approverColumn=REPORTS.expenses.columns.find(column=>column.key==='approved_by_name');
  assert.equal(creatorColumn.label,'Created By');assert.equal(approverColumn.label,'Approved By');
  const report=(await pg.query(`SELECT ${creatorColumn.expr} AS creator,${approverColumn.expr} AS approver FROM expenses e WHERE e.id=12`)).rows[0];
  assert.deepEqual(report,{creator:'Creator',approver:'Approver'});
  reads=0;
  const payload={entries:[{id:1,created_by:2,approved_by:3,debit:'50.25',assigned_admin_id:4},
   {id:'source:12',source_key:'expenses',source_id:12,site_id:10},
   {id:'outside',source_key:'expenses',source_id:13,site_id:10},
   {id:'other-site',source_key:'expenses',source_id:14,site_id:10},
   {id:2,created_by:4,approved_by:4},
   {id:3,created_by:2,created_by_name:'Recorded historical name'}],nested:{payments:[{id:4,created_by:2,approved_by:null},{id:'farmer:1',source_key:'farmer_payments',source_id:1,site_id:10}]}};
  const original=structuredClone(payload);
  const result=await withTransactionAttribution(payload,{id:1},db);
  assert.equal(reads,3,'one batched source read per module and one batched user read');
  assert.equal(result.entries[0].created_by_name,'Creator');assert.equal(result.entries[0].approved_by_name,'Approver');
  assert.equal(result.entries[0].debit,'50.25');
  assert.equal(result.entries[1].created_by_name,'Creator');assert.equal(result.entries[1].approved_by_name,'Approver');
  assert.equal(result.entries[2].created_by_name,undefined);assert.equal(result.entries[3].approved_by_name,undefined);
  assert.equal(result.entries[4].created_by_name,null);assert.equal(result.entries[4].approved_by_name,null);
  assert.equal(result.entries[5].created_by_name,'Recorded historical name');
  assert.equal(result.nested.payments[0].created_by_name,'Creator');assert.equal(result.nested.payments[0].approved_by,null);
  assert.equal(result.nested.payments[1].approved_by_name,'Approver','related payment sources inherit their site from the parent record');
  assert.deepEqual(payload,original,'response enrichment cannot mutate cached financial rows');
  reads=0;await withTransactionAttribution({entries:[]},{id:1},db);assert.equal(reads,0);
 }finally{await pg.close();}
});
test('response enrichment leaves writes, errors, and unauthenticated responses untouched', async () => {
 for(const [method,path,status,user] of [['POST','/expenses',200,{id:1}],['GET','/expenses',403,{id:1}],['GET','/auth/me',200,{id:1}],['GET','/expenses',200,null]]){
  const payload={entries:[{id:1,created_by:2}]};let sent;
  const res={statusCode:status,json(value){sent=value;return this;}};
  transactionAttributionMiddleware({method,path,user},res,()=>{});assert.equal(res.json(payload),res);assert.equal(sent,payload);
 }
 const payload={entries:[]};let send;const delivered=new Promise(resolve=>{send=resolve;});
 const req={method:'GET',path:'/farmers/51',user:{id:1}};const res={statusCode:200,json:value=>send(value)};
 transactionAttributionMiddleware(req,res,error=>{if(error)throw error;});res.json(payload);
 assert.deepEqual(await delivered,payload);
});
