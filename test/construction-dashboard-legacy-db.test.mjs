import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { graphql } from 'graphql';
import pool from '../src/config/db.js';
import { schema } from '../src/graphql/schema.js';
import { getConstructionSummaryData } from '../src/controllers/construction.controller.js';

const admin={id:1,role:'admin',organization_id:1};
const owner={id:2,role:'sub_admin',organization_id:1};
async function fixture(t) {
 const pg=new PGlite();const original=pool.query;pool.query=(sql,args)=>pg.query(sql,args);
 t.after(async()=>{pool.query=original;await pg.close();});
 await pg.exec(`
  CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(1,1),(2,1),(3,2);
  CREATE TABLE users(id int PRIMARY KEY,name text);INSERT INTO users VALUES(1,'Admin'),(2,'Owner'),(3,'Other');
  CREATE TABLE user_sites(user_id int,site_id int);INSERT INTO user_sites VALUES(2,1);
  CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean);
  INSERT INTO user_permissions VALUES(2,'construction',true,false),(2,'vendors',false,false);
  CREATE TABLE construction_projects(id int PRIMARY KEY,site_id int,name text,code text,status text,start_date date,
   target_end_date date,actual_end_date date,budget numeric,progress_pct int,notes text,assigned_admin_id int,created_by int);
  INSERT INTO construction_projects(id,site_id,name,status,budget,progress_pct,assigned_admin_id,created_by)
   VALUES(1,1,'Road works','ACTIVE',1000,10,2,1),(2,1,'Private works','PLANNING',500,0,3,1),(3,2,'Other site','ACTIVE',9000,0,2,1);
  CREATE TABLE construction_tasks(id int,project_id int,status text,progress_pct int,due_date date);
  INSERT INTO construction_tasks VALUES(1,1,'IN_PROGRESS',40,CURRENT_DATE-1),(2,1,'DONE',100,CURRENT_DATE-1);
  CREATE TABLE construction_material_requests(id int,project_id int,site_id int,status text);
  INSERT INTO construction_material_requests VALUES(1,1,1,'REQUESTED');
  CREATE TABLE inventory_movements(id int,project_id int,movement_type text,qty numeric,rate numeric);
  INSERT INTO inventory_movements VALUES(1,1,'CONSUMPTION',3,10);
  CREATE TABLE vendor_commitments(id int PRIMARY KEY,site_id int,vendor_name text,contract_amount numeric,status text);
  INSERT INTO vendor_commitments VALUES(1,1,'Road vendor',100,'open');
  CREATE TABLE vendor_payments(id int,site_id int,commitment_id int,payment_date date,amount numeric,tds_amount numeric,
   payment_mode text,status text,cheque_status text,created_by int);
  INSERT INTO vendor_payments VALUES(1,1,1,CURRENT_DATE,40,1,'bank','approved',NULL,1),
   (2,1,1,CURRENT_DATE,10,0,'bank','pending',NULL,2),(3,1,1,CURRENT_DATE,20,0,'cheque','approved','PENDING',1);
  CREATE TABLE ledger_entries(id text,site_id int,source_key text,source_id int,ledger_type text,debit numeric,credit numeric);
  INSERT INTO ledger_entries VALUES('canonical',1,'vendor_payments',1,'site',35,0),
   ('custody',1,'vendor_payments',1,'person',40,0),('other site',2,'vendor_payments',1,'site',999,0);
  CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE sql AS $$
   SELECT $2='approved' AND (lower($3)<>'cheque' OR $4='CLEARED')
  $$;
 `);
 return pg;
}
const summary=(user=admin,projectId=null)=>getConstructionSummaryData({siteId:1,user,projectId});

test('active projects include approved work across REST/GraphQL while review, paused and finished work stay separate',async t=>{
 const pg=await fixture(t);
 for(const [status,expected] of Object.entries({NEED:0,PLANNING:0,REVIEW:0,APPROVED:1,COMMITTED:1,IN_PROGRESS:1,ACTIVE:1,DELAYED:1,ON_HOLD:0,COMPLETED:0,CLOSED:0,CANCELLED:0})){
  await pg.query('UPDATE construction_projects SET status=$1 WHERE id=1',[status]);
  const result=(await summary(owner)).summary;
  assert.equal(result.active_projects,expected,status);assert.equal(result.total_projects,1);
  assert.equal(result.total_budget,'1000.00');assert.equal(result.paid_amount,'0.00');
 }
 await pg.query("UPDATE construction_projects SET status='APPROVED' WHERE id=1");
 const response=await graphql({schema,source:'{constructionDashboard(siteId:1){activeProjects totalBudget}}',
  contextValue:{user:owner,siteIds:new Set([1]),permissions:new Map([['construction',{can_read:true}]])}});
 assert.equal(response.errors,undefined,JSON.stringify(response.errors));
 assert.equal(response.data.constructionDashboard.activeProjects,1);assert.equal(response.data.constructionDashboard.totalBudget,1000);
});

test('pre-141/219 dashboard returns real project progress and material metrics without optional columns/tables',async t=>{
 const pg=await fixture(t);const before=(await pg.query('SELECT * FROM vendor_payments')).rows;
 const {summary:result}=await summary(owner);
 assert.equal(result.total_projects,1);assert.equal(result.active_projects,1);
 assert.equal(result.total_budget,'1000.00');assert.equal(result.avg_progress,70);
 assert.equal(result.overdue_tasks,1);assert.equal(result.total_actual_cost,'30.00');
 assert.equal(result.pending_material_requests,1);assert.equal(result.total_locations,0);
 assert.equal(result.paid_amount,'0.00','unlinked site payments cannot be guessed into a project');
 assert.equal(result.remaining_budget,'1000.00');assert.deepEqual(result.recent_activity,[]);
 assert.deepEqual(result.project_type_counts,[{project_type:'GENERAL',count:1}]);
 assert.deepEqual(result.projects.map(project=>project.id),[1]);
 assert.deepEqual((await pg.query('SELECT * FROM vendor_payments')).rows,before);
});

test('legacy dashboard and GraphQL preserve site, assignment and project filters',async t=>{
 await fixture(t);
 assert.equal((await summary(admin)).summary.total_budget,'1500.00');
 assert.equal((await summary(owner,2)).summary.total_projects,0);
 await assert.rejects(summary(owner,'1junk'),error=>error.statusCode===400);
 await assert.rejects(getConstructionSummaryData({siteId:2,user:owner}),error=>error.statusCode===403);
 await assert.rejects(getConstructionSummaryData({siteId:3,user:admin}),error=>error.statusCode===404);
 const response=await graphql({schema,source:'{constructionDashboard(siteId:1){activeProjects avgProgress totalBudget totalActualCost pendingMaterialRequests}}',
  contextValue:{user:owner,siteIds:new Set([1]),permissions:new Map([['construction',{can_read:true}]])}});
 assert.equal(response.errors,undefined,JSON.stringify(response.errors));
 assert.deepEqual(JSON.parse(JSON.stringify(response.data.constructionDashboard)),{activeProjects:1,avgProgress:70,totalBudget:1000,totalActualCost:30,pendingMaterialRequests:1});
});

test('applying optional schema restores locations, activity and canonical project payments without a restart',async t=>{
 const pg=await fixture(t);await summary(owner);
 await pg.exec(`
  ALTER TABLE construction_projects ADD COLUMN owner_user_id int,ADD COLUMN assigned_approver_id int,ADD COLUMN project_type text;
  ALTER TABLE construction_tasks ADD COLUMN owner_user_id int;
  ALTER TABLE vendor_commitments ADD COLUMN project_id int;UPDATE vendor_commitments SET project_id=1;
  CREATE TABLE construction_locations(id int,project_id int,status text);INSERT INTO construction_locations VALUES(1,1,'ACTIVE');
  CREATE TABLE construction_project_activity(id int,project_id int,actor_id int,action text,entity_type text,entity_id int,created_at timestamptz);
  INSERT INTO construction_project_activity VALUES(1,1,1,'project_updated','project',1,NOW());
 `);
 const result=(await summary(owner)).summary;
 assert.equal(result.paid_amount,'35.00');assert.equal(result.total_actual_cost,'30.00');
 assert.equal(result.committed_value,'100.00');assert.equal(result.gross_settled_amount,'41.00');
 assert.equal(result.pending_amount,'10.00');assert.equal(result.remaining_budget,'965.00');
 assert.equal(result.total_locations,1);assert.equal(result.recent_activity.length,1);
 assert.deepEqual(result.recent_payments,[],'construction access does not reveal vendor histories');
 await pg.query("UPDATE user_permissions SET can_read=true WHERE module='vendors'");
 assert.deepEqual((await summary(owner)).summary.recent_payments.map(payment=>payment.id),[2]);
});

test('a required ledger failure is surfaced instead of presenting invented zero payments',async t=>{
 const pg=await fixture(t);await pg.exec('DROP TABLE ledger_entries');
 await assert.rejects(summary(admin),error=>error.code==='42P01');
});
