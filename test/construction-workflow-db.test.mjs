import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { constructionWorkflowSchemaSql, up } from '../src/migrations/219_construction_workflow.js';
import { assertConstructionSiteAccess, assertConstructionProjectAccess, constructionCanViewAll, validateConstructionAssignment, validateProjectTransition, decimalAmount, dateValue, projectMetricsSql, projectAccessPredicate } from '../src/services/constructionWorkflow.service.js';
import { createProject, updateProject, createTask, updateTask, createQuote, updateQuote, selectQuote, listProjects, constructionSummary, getProject, createMaterialRequest, issueMaterialRequest, updateMaterialRequest, consumeMaterial, requireConstructionAccess } from '../src/controllers/construction.controller.js';

const admin={id:1,role:'admin',organization_id:1};
const owner={id:2,role:'sub_admin',organization_id:1};
const outsider={id:3,role:'sub_admin',organization_id:1};
const reviewer={id:4,role:'sub_admin',organization_id:1};
const invoke=(fn,{user=admin,params={},body={},query={},method='GET'}={})=>new Promise((resolve,reject)=>{
 const req={user,params,body,query:{site_id:1,...query},method};
 const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,...data});}};
 fn(req,res,error=>error?reject(error):resolve(req));
});
const fixture=`
 CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
 CREATE TABLE sites(id int PRIMARY KEY,organization_id int NOT NULL);
 CREATE TABLE users(id int PRIMARY KEY,name text,role text,is_active boolean DEFAULT true,organization_id int DEFAULT 1);
 CREATE TABLE user_sites(user_id int,site_id int,PRIMARY KEY(user_id,site_id));
 CREATE TABLE user_permissions(user_id int,module text,can_read boolean DEFAULT false,can_write boolean DEFAULT false,can_update boolean DEFAULT false,can_view_all boolean DEFAULT false,PRIMARY KEY(user_id,module));
 CREATE TABLE members(id int PRIMARY KEY,full_name text,site_id int,member_type text,member_types text[]);
 CREATE TABLE vendor_heads(id int PRIMARY KEY,site_id int,name text,is_active boolean DEFAULT true);
 CREATE TABLE construction_projects(id serial PRIMARY KEY,site_id int REFERENCES sites(id),name text,code text,project_type text DEFAULT 'GENERAL',status varchar(20) DEFAULT 'PLANNING' CHECK(status IN('PLANNING','ACTIVE','ON_HOLD','DELAYED','COMPLETED','CANCELLED')),start_date date,target_end_date date,actual_end_date date,budget numeric(15,2) DEFAULT 0,progress_pct int DEFAULT 0,notes text,assigned_admin_id int REFERENCES users(id),created_by int REFERENCES users(id),created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE construction_locations(id serial PRIMARY KEY,project_id int REFERENCES construction_projects(id),parent_id int,location_type text,name text,status text,sequence int,created_at timestamptz DEFAULT now());
 CREATE TABLE construction_tasks(id serial PRIMARY KEY,project_id int REFERENCES construction_projects(id),location_id int,name text,status text DEFAULT 'PENDING',progress_pct int DEFAULT 0,sequence int DEFAULT 0,start_date date,due_date date,created_by int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE construction_material_requests(id serial PRIMARY KEY,project_id int REFERENCES construction_projects(id),site_id int,task_id int REFERENCES construction_tasks(id) ON DELETE SET NULL,location_id int,status text,note text,requested_by int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE inventory_materials(id serial PRIMARY KEY,site_id int,name text,unit text,rate numeric(15,2));
 CREATE TABLE construction_material_request_items(id serial PRIMARY KEY,request_id int REFERENCES construction_material_requests(id),material_id int REFERENCES inventory_materials(id),qty_requested numeric(15,3),qty_issued numeric(15,3) DEFAULT 0);
 CREATE TABLE inventory_movements(id serial PRIMARY KEY,site_id int,material_id int,movement_type text,qty numeric(15,3),rate numeric(15,2),project_id int,task_id int,request_id int,location_id int,ref_type text,ref_id int,note text,created_by int,expiry_date date,created_at timestamptz DEFAULT now());
 CREATE TABLE vendor_commitments(id serial PRIMARY KEY,site_id int,project_id int REFERENCES construction_projects(id),location_id int,vendor_member_id int,vendor_name text,head_id int,head_name text,work_title text,contract_amount numeric(14,2),start_date date,due_date date,note text,status text DEFAULT 'open',created_by int,assigned_admin_id int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE vendor_payments(id serial PRIMARY KEY,site_id int,commitment_id int REFERENCES vendor_commitments(id),payment_date date,amount numeric(14,2),tds_amount numeric(14,2) DEFAULT 0,payment_mode text,reference_no text,status text,cheque_status text,note text,created_by int,created_at timestamptz DEFAULT now());
 CREATE TABLE ledger_entries(id text PRIMARY KEY,site_id int,source_key text,source_id int,ledger_type text,debit numeric(15,2),credit numeric(15,2));
 CREATE FUNCTION financial_transaction_posts(direction text,status text,mode text,cheque text) RETURNS boolean LANGUAGE SQL AS $$SELECT status='approved' AND (lower(mode)<>'cheque' OR upper(cheque)='CLEARED')$$;
 CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS $$SELECT$$;
 CREATE FUNCTION pg_advisory_xact_lock(integer,integer) RETURNS void LANGUAGE SQL AS $$SELECT$$;
 INSERT INTO sites VALUES(1,1),(2,1),(3,2);
 INSERT INTO users(id,name,role) VALUES(1,'Admin','admin'),(2,'Owner','sub_admin'),(3,'Other user','sub_admin'),(4,'Reviewer','sub_admin');
 INSERT INTO users(id,name,role,organization_id) VALUES(5,'Other organization','admin',2);
 INSERT INTO user_sites VALUES(2,1),(3,1),(4,1);
 INSERT INTO user_permissions(user_id,module,can_read,can_write,can_update,can_view_all) VALUES
 (2,'construction',true,true,true,false),(3,'construction',true,true,true,false),(4,'construction',true,false,true,false),(4,'expense_approval',true,false,false,false);
 INSERT INTO members VALUES(1,'Road Vendor',1,'VENDOR',ARRAY['VENDOR']),(2,'Wrong Site Vendor',2,'VENDOR',ARRAY['VENDOR']);
 INSERT INTO inventory_materials VALUES(1,1,'Cement','BAG',10),(2,2,'Other-site material','BAG',20);
`;

test('construction lifecycle, assigned access, quote selection and ledger-derived summaries on isolated PostgreSQL',async t=>{
 const pg=new PGlite();
 const original={query:pool.query,connect:pool.connect};
 const db={query:(sql,args=[])=>args.length?pg.query(sql,args):pg.exec(sql).then(r=>r.at(-1)),release(){}};
 pool.query=db.query;pool.connect=async()=>db;
 try {
  await pg.exec(fixture);await up({connect:async()=>db});await up({connect:async()=>db});
  await t.test('site and organization boundaries, project assignment and explicit view-all remain independent',async()=>{
   await assertConstructionSiteAccess(db,owner,1);
   await assert.rejects(assertConstructionSiteAccess(db,owner,2),/Access denied/);
   await assert.rejects(assertConstructionSiteAccess(db,admin,3),/Site not found/);
   await assert.rejects(validateConstructionAssignment(db,1,5),/Assigned user/);
   await assert.rejects(validateConstructionAssignment(db,2,2),/Assigned user/);
   await assert.rejects(validateConstructionAssignment(db,1,2,{approver:true}),/approval permission/);
   assert.equal(await validateConstructionAssignment(db,1,4,{approver:true}),4);
   assert.equal(await validateConstructionAssignment(db,1,2,{approver:true,approvalModule:'construction'}),2);
  });
  let projectId,taskId,quoteId,commitmentId;
  await t.test('need validation, administrator assignments and approval authority',async()=>{
   await assert.rejects(invoke(createProject,{body:{name:'Road',status:'APPROVED',budget:'100'}}),/start as a need/);
   await assert.rejects(invoke(createProject,{body:{name:'Road',budget:'-1'}}),/Budget/);
   await assert.rejects(invoke(createProject,{body:{name:'Road',budget:'100',start_date:'2026-11-02',target_end_date:'2026-11-01'}}),/End date/);
   await assert.rejects(invoke(createProject,{user:owner,body:{name:'Road',budget:'100',owner_user_id:3}}),/Only administrators/);
   const created=await invoke(createProject,{body:{name:'Road',budget:'100.00',owner_user_id:2,assigned_approver_id:4,scope:'Road making',priority:'HIGH'}});
   projectId=created.project.id;assert.equal(created.project.status,'NEED');assert.equal(created.project.requested_by,1);
   await assertConstructionProjectAccess(db,owner,projectId,1);
   await assert.rejects(assertConstructionProjectAccess(db,outsider,projectId,1),/access denied/);
   const scoped=await invoke(listProjects,{user:outsider});assert.equal(scoped.projects.length,0);
   await pg.query("UPDATE user_permissions SET can_view_all=true WHERE user_id=3 AND module='construction'");
   assert.equal(await constructionCanViewAll(db,outsider),true);await assertConstructionProjectAccess(db,outsider,projectId,1);
   await assert.rejects(assertConstructionSiteAccess(db,outsider,2),/Access denied/);
   await pg.query("UPDATE user_permissions SET can_view_all=false WHERE user_id=3 AND module='construction'");
   await assert.rejects(invoke(requireConstructionAccess,{user:outsider,params:{id:projectId}}),/access denied/);
   await assert.rejects(invoke(requireConstructionAccess,{user:outsider,params:{id:`${projectId}junk`}}),/Invalid project id/);
   await assert.rejects(invoke(requireConstructionAccess,{user:owner,params:{id:'1e3'}}),/Invalid project id/);
   await assert.rejects(invoke(updateProject,{user:owner,params:{id:projectId},body:{status:'IN_PROGRESS'}}),/cannot move/);
   await invoke(updateProject,{user:owner,params:{id:projectId},body:{status:'REVIEW'}});
   await assert.rejects(invoke(updateProject,{user:owner,params:{id:projectId},body:{status:'APPROVED'}}),/assigned approver/);
   const approved=await invoke(updateProject,{user:reviewer,params:{id:projectId},body:{status:'APPROVED'}});assert.equal(approved.project.approved_by,4);
  });
  await t.test('quote validation and selection create one commitment on retry, with budget enforced',async()=>{
   await assert.rejects(invoke(createQuote,{params:{id:projectId},body:{vendor_member_id:2,amount:'70'}}),/invalid for this site/);
   const q=await invoke(createQuote,{params:{id:projectId},body:{vendor_member_id:1,amount:'70.00',scope:'Road work',terms:'Against milestones'}});quoteId=q.quote.id;
   const selected=await invoke(selectQuote,{params:{quoteId},body:{head_name:'Construction'}});commitmentId=selected.commitment.id;assert.equal(selected.commitment.contract_amount,'70.00');assert.equal(selected.commitment.assigned_admin_id,null,'project owner is never silently made a financial approver');
   const retry=await invoke(selectQuote,{params:{quoteId}});assert.equal(retry.replayed,true);assert.equal(retry.commitment.id,commitmentId);
   assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM vendor_commitments')).rows[0].n,1);
   assert.equal((await pg.query('SELECT status FROM construction_projects WHERE id=$1',[projectId])).rows[0].status,'COMMITTED');
   await assert.rejects(invoke(updateQuote,{params:{quoteId},body:{amount:'60'}}),/locked/);
   const tooBig=await invoke(createQuote,{params:{id:projectId},body:{vendor_name:'Second',amount:'40'}});
   await assert.rejects(invoke(selectQuote,{params:{quoteId:tooBig.quote.id}}),/remaining project budget/);
   await assert.rejects(invoke(updateProject,{params:{id:projectId},body:{budget:'60'}}),/existing vendor commitments/);
   await assert.rejects(invoke(updateProject,{user:owner,params:{id:projectId},body:{budget:'1000'}}),/Only administrators can change an approved/);
  });
  await t.test('task assignments, progress, overdue tasks and completion guards',async()=>{
   await assert.rejects(invoke(createTask,{user:owner,params:{id:projectId},body:{name:'Work',owner_user_id:3}}),/Only administrators/);
   const task=await invoke(createTask,{params:{id:projectId},body:{name:'Milestone',owner_user_id:3,due_date:'2020-01-01',progress_pct:25,is_milestone:true,notes:'Check work'}});taskId=task.task.id;
   await assertConstructionProjectAccess(db,outsider,projectId,1);
   await assert.rejects(invoke(updateTask,{params:{taskId},body:{progress_pct:120}}),/between 0 and 100/);
   await invoke(updateProject,{params:{id:projectId},body:{status:'IN_PROGRESS'}});
   await assert.rejects(invoke(updateProject,{params:{id:projectId},body:{status:'COMPLETED'}}),/Complete all tasks/);
   const rows=await pg.query(`${projectMetricsSql} WHERE p.id=$1`,[projectId]);assert.equal(rows.rows[0].calculated_progress_pct,25);assert.equal(rows.rows[0].overdue_tasks,1);
  });
  await t.test('project and dashboard paid amounts equal the canonical ledger across split/custody/pending entries',async()=>{
   await pg.query(`INSERT INTO vendor_payments(id,site_id,commitment_id,payment_date,amount,payment_mode,status,created_by) VALUES(1,1,$1,'2026-10-01',40,'bank','approved',1),(2,1,$1,'2026-10-02',10,'cash','pending',1),(3,1,$1,'2026-10-03',5,'cheque','approved',1),(4,1,$1,'2026-10-04',2,'bank','rejected',1)`,[commitmentId]);
   await pg.query('UPDATE vendor_payments SET tds_amount=2 WHERE id=1');
   await pg.exec(`INSERT INTO ledger_entries VALUES('split1',1,'vendor_payments',1,'site',15,0),('split2',1,'vendor_payments',1,'site',25,0),('custody',1,'vendor_payments',1,'person',40,0),('expense_other',1,'expenses',1,'site',7,0),('other_site',2,'vendor_payments',1,'site',100,0)`);
   const detail=await invoke(getProject,{params:{id:projectId}});assert.equal(detail.project.paid_amount,'40.00');assert.equal(detail.project.approved_amount,'45.00');assert.equal(detail.project.pending_amount,'10.00');assert.equal(detail.project.remaining_budget,'60.00');assert.equal(detail.project.outstanding_amount,'30.00');assert.equal(detail.project.gross_settled_amount,'42.00');assert.equal(detail.project.contractual_outstanding_amount,'28.00');assert.equal(detail.project.progress_pct,25);assert.equal(detail.vendor_payments.length,4);assert.equal(detail.vendor_commitments[0].paid_amount,'40.00');
   const summary=await invoke(constructionSummary,{query:{project_id:projectId}});assert.equal(summary.summary.paid_amount,'40.00');assert.equal(summary.summary.committed_value,'70.00');assert.equal(summary.summary.overdue_tasks,1);assert.equal(summary.summary.recent_payments.length,4);assert.ok(summary.summary.recent_activity.length>0);
   await pg.query("INSERT INTO construction_project_activity(project_id,actor_id,action,entity_type,entity_id,details) VALUES($1,1,'payment_recorded','vendor_payment',1,'{\"amount\":40}')",[projectId]);
   const restrictedDetail=await invoke(getProject,{user:owner,params:{id:projectId}});assert.equal(restrictedDetail.project.paid_amount,'40.00');assert.equal(restrictedDetail.vendor_payments.length,0);assert.equal(restrictedDetail.payment_history_restricted,true);assert.equal(restrictedDetail.activity.some(event=>event.entity_type==='vendor_payment'),false);
   await pg.query("INSERT INTO user_permissions(user_id,module,can_read,can_view_all) VALUES(2,'vendors',true,false)");
   await pg.query('UPDATE vendor_payments SET created_by=2 WHERE id=2');
   const ownHistory=await invoke(getProject,{user:owner,params:{id:projectId}});assert.deepEqual(ownHistory.vendor_payments.map(payment=>payment.id),[2]);
   const ownSummary=await invoke(constructionSummary,{user:owner});assert.deepEqual(ownSummary.summary.recent_payments.map(payment=>payment.id),[2]);assert.equal(ownSummary.summary.paid_amount,'40.00');
   const hidden=await invoke(constructionSummary,{user:owner,query:{project_id:999}});assert.equal(hidden.summary.paid_amount,'0.00');
   const created=await invoke(createProject,{body:{name:'Unrelated',budget:'999'}});
   const filtered=await invoke(constructionSummary,{query:{project_id:created.project.id}});assert.equal(filtered.summary.total_budget,'999.00');assert.equal(filtered.summary.paid_amount,'0.00');assert.equal(filtered.summary.recent_payments.length,0);
  });
  await t.test('GraphQL constructionDashboard shares the scoped summary engine and enforces current permissions',async()=>{
   const {graphql}=await import('graphql');const {schema}=await import('../src/graphql/schema.js');
   const query=`query {constructionDashboard(siteId:1){activeProjects delayedProjects avgProgress pendingMaterialRequests totalBudget totalActualCost}}`;
   const context={user:owner,siteIds:new Set([1]),permissions:new Map([['construction',{can_read:true}]])};
   const result=await graphql({schema,source:query,contextValue:context});assert.equal(result.errors,undefined,JSON.stringify(result.errors));
   const expected=(await invoke(constructionSummary,{user:owner})).summary;
   assert.deepEqual({...result.data.constructionDashboard},{activeProjects:expected.active_projects,delayedProjects:expected.delayed_projects,avgProgress:expected.avg_progress,pendingMaterialRequests:expected.pending_material_requests,totalBudget:Number(expected.total_budget),totalActualCost:Number(expected.total_actual_cost)});
   assert.equal(result.data.constructionDashboard.totalBudget,100,'unassigned unrelated project is excluded');
   const noGrant=await graphql({schema,source:query,contextValue:{...context,permissions:new Map()}});assert.equal(noGrant.errors[0].extensions.code,'FORBIDDEN');
   const noSite=await graphql({schema,source:query,contextValue:{...context,siteIds:new Set()}});assert.equal(noSite.errors[0].extensions.code,'FORBIDDEN');
   const otherOrg=await graphql({schema,source:`query{constructionDashboard(siteId:3){totalBudget}}`,contextValue:{user:admin}});assert.match(otherOrg.errors[0].message,/Site not found/);
  });
  await t.test('material request issues preserve inventory history and forbid forged fulfillment or cancelled issued stock',async()=>{
   const invalid=await invoke(createMaterialRequest,{params:{id:projectId},body:{items:[{material_id:1,qty:3},{material_id:2,qty:0}]}});assert.equal(invalid.status,400);assert.match(invalid.message,/Every item/);
   const bad=await invoke(createMaterialRequest,{params:{id:projectId},body:{items:[{material_id:2,qty:1}]}});assert.equal(bad.status,400);
   const made=await invoke(createMaterialRequest,{params:{id:projectId},body:{items:[{material_id:1,qty:5}]}});const reqId=made.request.id;
   await assert.rejects(invoke(updateMaterialRequest,{params:{reqId},body:{status:'FULFILLED'}}),/derived from issued stock/);
   await pg.query("INSERT INTO inventory_movements(site_id,material_id,movement_type,qty,rate) VALUES(1,1,'RECEIPT',3,10)");
   const issued=await invoke(issueMaterialRequest,{params:{reqId}});assert.equal(issued.status,'PARTIALLY_FULFILLED');assert.equal(issued.issued[0].qty,3);
   await assert.rejects(invoke(updateMaterialRequest,{params:{reqId},body:{status:'CANCELLED'}}),/issued requests/);
   const retry=await invoke(issueMaterialRequest,{params:{reqId}});assert.equal(retry.issued.length,0);
   assert.equal((await pg.query("SELECT COUNT(*)::int n FROM inventory_movements WHERE movement_type='ISSUE'")).rows[0].n,1);
   const consume=await invoke(consumeMaterial,{params:{id:projectId},body:{material_id:1,qty:1}});assert.equal(consume.status,400);
  });
  await t.test('completion and close retain financial and activity history',async()=>{
   await invoke(updateTask,{params:{taskId},body:{status:'DONE'}});
   await invoke(updateProject,{params:{id:projectId},body:{status:'COMPLETED'}});
   await assert.rejects(invoke(updateProject,{params:{id:projectId},body:{status:'CLOSED'}}),/pending vendor payments/);
   await pg.query("UPDATE vendor_payments SET status='rejected' WHERE id=2");
   const closed=await invoke(updateProject,{params:{id:projectId},body:{status:'CLOSED'}});assert.equal(closed.project.progress_pct,100);
   await assert.rejects(invoke(updateProject,{params:{id:projectId},body:{name:'Rewrite'}}),/cannot be changed/);
   assert.ok((await pg.query('SELECT COUNT(*)::int n FROM construction_project_activity WHERE project_id=$1',[projectId])).rows[0].n>10);
  });
 }finally{pool.query=original.query;pool.connect=original.connect;await pg.close();}
});

test('decimal and lifecycle validation reject malformed data without floating point arithmetic',()=>{
 assert.equal(decimalAmount('999999999999.99'),'999999999999.99');
 for(const amount of ['NaN','Infinity','1e3','-1','1.001','0'])assert.throws(()=>decimalAmount(amount));
 assert.equal(decimalAmount('0.00','Budget',{allowZero:true}),'0.00');
 assert.throws(()=>dateValue('2026-02-30'));
 assert.throws(()=>validateProjectTransition('CLOSED','IN_PROGRESS'),/cannot move/);
 assert.throws(()=>projectAccessPredicate('p;drop table x'));
 assert.match(constructionWorkflowSchemaSql,/ON DELETE RESTRICT/);
});
