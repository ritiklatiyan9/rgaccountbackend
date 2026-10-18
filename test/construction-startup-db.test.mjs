import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { ensureConstructionStartup } from '../src/services/constructionStartup.service.js';
import { listProjects, getProject, requireConstructionAccess } from '../src/controllers/construction.controller.js';
import { listConstructionProjectOptions, listVendorCommitments, listAllInventoryItems } from '../src/controllers/vendor.controller.js';
import { listInventoryOrders, listInventoryCategories, getInventoryStockSummary } from '../src/controllers/vendorInventory.controller.js';

const invoke=(handler,params={})=>new Promise((resolve,reject)=>handler({method:'GET',user:{id:1,role:'admin',organization_id:1},query:{site_id:1},body:{},params},
 {json:resolve,status(){return this;}},error=>error?reject(error):resolve()));
const baseline=`
 CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
 CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(1,1);
 CREATE TABLE users(id int PRIMARY KEY,name text);INSERT INTO users VALUES(1,'Admin');
 CREATE TABLE members(id int PRIMARY KEY);
 CREATE TABLE construction_projects(id serial PRIMARY KEY,site_id int,name text,code text,status text DEFAULT 'PLANNING',
 budget numeric DEFAULT 0,progress_pct int DEFAULT 0,start_date date,target_end_date date,actual_end_date date,notes text,
 assigned_admin_id int,created_by int,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 INSERT INTO construction_projects(site_id,name,status,budget,created_by) VALUES(1,'Existing road','ACTIVE',1000,1);
 CREATE TABLE construction_tasks(id serial PRIMARY KEY,project_id int,status text,progress_pct int,due_date date,sequence int);
 CREATE TABLE construction_material_requests(id serial PRIMARY KEY,project_id int,status text,requested_by int,created_at timestamptz);
 CREATE TABLE construction_material_request_items(id serial PRIMARY KEY,request_id int,material_id int,qty_requested numeric,qty_issued numeric);
 CREATE TABLE inventory_materials(id int PRIMARY KEY,name text,unit text);
 CREATE TABLE inventory_movements(id serial PRIMARY KEY,site_id int,project_id int,movement_type text,qty numeric,rate numeric,material_id int,created_by int,created_at timestamptz);
 CREATE TABLE vendor_commitments(id serial PRIMARY KEY,site_id int,vendor_member_id int,vendor_name text,work_title text,head_name text,
 contract_amount numeric,status text,start_date date,due_date date);
 INSERT INTO vendor_commitments(site_id,vendor_name,contract_amount,status) VALUES(1,'Existing vendor',100,'open');
 CREATE TABLE vendor_inventory_orders(id serial PRIMARY KEY,site_id int,commitment_id int);
 CREATE TABLE vendor_payments(id serial PRIMARY KEY,site_id int,commitment_id int,payment_date date,amount numeric,tds_amount numeric,
 payment_mode text,status text,cheque_status text,created_by int,approved_at timestamptz,cheque_no text);
 INSERT INTO vendor_payments(site_id,commitment_id,payment_date,amount,tds_amount,payment_mode,status,created_by)
 VALUES(1,1,CURRENT_DATE,40,0,'bank','approved',1);
 CREATE TABLE vendor_inventory_payments(id serial PRIMARY KEY,order_id int,source_vendor_payment_id int,amount numeric);
 CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,source_module text,source_id int,site_id int,date date,debit numeric,credit numeric,status text);
 INSERT INTO cash_flow_entries(source_module,source_id,site_id,date,debit,credit,status) VALUES('vendor_payments',1,1,CURRENT_DATE,40,0,'approved');
 CREATE TABLE day_book(id int,vendor_payment_id int,entry_type text);
 CREATE VIEW ledger_entries AS SELECT id::text,site_id,source_module AS source_key,source_id,'site'::text AS ledger_type,debit,credit FROM cash_flow_entries;
 CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$SELECT $2='approved'$$;
 CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS $$SELECT$$;
 ALTER TABLE users ADD COLUMN email text;
 ALTER TABLE members ADD COLUMN full_name text;
 ALTER TABLE vendor_commitments ADD COLUMN head_id int,ADD COLUMN note text,ADD COLUMN created_by int,ADD COLUMN assigned_admin_id int,
 ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE vendor_inventory_orders ADD COLUMN vendor_member_id int,ADD COLUMN vendor_name text,ADD COLUMN item_name text,
 ADD COLUMN item_category text,ADD COLUMN unit text,ADD COLUMN qty_ordered numeric DEFAULT 10,ADD COLUMN rate numeric DEFAULT 2,
 ADD COLUMN discount_pct numeric DEFAULT 0,ADD COLUMN discount_amount numeric DEFAULT 0,ADD COLUMN total_paid numeric DEFAULT 0,
 ADD COLUMN order_date date DEFAULT CURRENT_DATE,ADD COLUMN expected_date date,ADD COLUMN note text,ADD COLUMN status text DEFAULT 'open',
 ADD COLUMN created_at timestamptz DEFAULT now();
 INSERT INTO vendor_inventory_orders(site_id,commitment_id,item_name,item_category) VALUES(1,1,'Stone','Materials');
 ALTER TABLE vendor_inventory_payments ADD COLUMN tds_amount numeric DEFAULT 0,ADD COLUMN status text,ADD COLUMN payment_mode text,
 ADD COLUMN cheque_status text,ADD COLUMN created_by int,ADD COLUMN site_id int,ADD COLUMN cheque_no text,ADD COLUMN payment_date date;
 ALTER TABLE inventory_movements ADD COLUMN ref_type text,ADD COLUMN ref_id int;
`;

test('fresh direct startup upgrades a legacy construction schema once, retaining source and ledger history',async t=>{
 const pg=new PGlite();const original={query:pool.query,connect:pool.connect};
 const db={query:(sql,args=[])=>args.length?pg.query(sql,args):pg.exec(sql).then(results=>results.at(-1)),release(){}};
 pool.query=db.query;pool.connect=async()=>db;
 t.after(async()=>{Object.assign(pool,original);await pg.close();});
 await pg.exec(baseline);
 const before=(await pg.query('SELECT * FROM vendor_payments')).rows;
 const mirrors=(await pg.query('SELECT * FROM cash_flow_entries')).rows;
 // The reported list endpoint also works before optional migrations arrive.
 assert.equal((await invoke(listProjects)).projects[0].name,'Existing road');
 const first=await ensureConstructionStartup(pool);
 assert.deepEqual(first.applied,['141_construction_portfolio_structure','219_construction_workflow','220_construction_payment_integrity']);
 assert.deepEqual(await ensureConstructionStartup(pool),{applied:[],current:true});
 assert.deepEqual((await pg.query('SELECT id,site_id,name,status,budget FROM construction_projects')).rows,
 [{id:1,site_id:1,name:'Existing road',status:'ACTIVE',budget:'1000'}]);
 // Additive metadata columns are allowed; every pre-existing payment value is retained.
 const after=(await pg.query('SELECT * FROM vendor_payments')).rows;
 for(const [key,value] of Object.entries(before[0]))assert.deepEqual(after[0][key],value,key);
 assert.deepEqual((await pg.query('SELECT * FROM cash_flow_entries')).rows,mirrors);
 assert.equal((await invoke(listProjects)).projects.length,1);
 await invoke(requireConstructionAccess,{id:1});
 const detail=await invoke(getProject,{id:1});
 assert.equal(detail.project.name,'Existing road');assert.deepEqual(detail.locations,[]);assert.deepEqual(detail.quotes,[]);
 assert.equal((await invoke(listConstructionProjectOptions)).projects.length,1);
 assert.equal((await invoke(listVendorCommitments)).commitments.length,1);
 assert.equal((await invoke(listInventoryOrders)).orders.length,1);
 assert.deepEqual((await invoke(listInventoryCategories)).categories,['Materials']);
 assert.equal((await invoke(listAllInventoryItems)).items.length,1);
 await invoke(getInventoryStockSummary);
 assert.equal((await pg.query('SELECT SUM(debit-credit) amount FROM ledger_entries')).rows[0].amount,'40');
});

test('startup stops at a failed prerequisite and retries missing versions in order',async()=>{
 const calls=[];const installed=new Set(['141']);
 const db={query:async()=>({rows:[...installed].map(version=>({version}))})};
 let fail=true;
 const migrations=[['141',async()=>assert.fail('installed migration reran')],['219',async()=>{calls.push('219');if(fail)throw new Error('lock unavailable');installed.add('219');}],['220',async()=>{calls.push('220');installed.add('220');}]];
 await assert.rejects(ensureConstructionStartup(db,migrations),/lock unavailable/);assert.deepEqual(calls,['219']);
 fail=false;await ensureConstructionStartup(db,migrations);assert.deepEqual(calls,['219','219','220']);
 assert.deepEqual(await ensureConstructionStartup(db,migrations),{applied:[],current:true});
});

test('direct server startup waits for construction prerequisites before listening',async()=>{
 const source=await readFile(new URL('../src/server.js',import.meta.url),'utf8');
 assert.ok(source.indexOf('await ensureConstructionStartup(pool)')<source.indexOf('server.listen(PORT'));
 assert.match(source,/import \{ ensureConstructionStartup \} from '.\/services\/constructionStartup.service.js'/);
});
