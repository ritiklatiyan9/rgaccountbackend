import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import requireVendorAccess from '../src/middlewares/vendorAccess.middleware.js';
import { getInventoryStockSummary } from '../src/controllers/vendorInventory.controller.js';

const request = (user, query = {}) => ({ user, query: { site_id:'1', ...query }, body:{}, path:'/inventory/stock-summary' });
const admin = { id:1, role:'admin', organization_id:1 };
const staff = { id:12, role:'sub_admin', organization_id:1,
  permissionsByModule:new Map([['vendors',{can_read:true,can_view_all:false}]]) };
const invoke = req => new Promise((resolve,reject) => {
  const res={statusCode:200,status(code){this.statusCode=code;return this;},json(data){resolve({status:this.statusCode,data});}};
  requireVendorAccess(req,res,error=>error?reject(error):getInventoryStockSummary(req,res,reject));
});

async function fixture(t,{upgraded=false}={}) {
  const pg=new PGlite();
  const original=pool.query;
  pool.query=(sql,params)=>pg.query(sql,params);
  t.after(async()=>{pool.query=original;await pg.close();});
  await pg.exec(`
    CREATE TABLE sites(id int PRIMARY KEY,organization_id int);
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    CREATE TABLE user_sites(user_id int,site_id int);INSERT INTO user_sites VALUES(12,1);
    CREATE TABLE user_permissions(user_id int,module text,can_view_all boolean);
    INSERT INTO user_permissions VALUES(12,'construction',false);
    -- Match the pre-141/pre-219 deployed schema: no project_id on orders,
    -- no owner/approver columns on projects or tasks.
    CREATE TABLE construction_projects(id int PRIMARY KEY,site_id int,created_by int,assigned_admin_id int);
    INSERT INTO construction_projects VALUES(10,1,1,NULL),(20,1,1,NULL);
    CREATE TABLE construction_tasks(id int,project_id int);
    CREATE TABLE vendor_inventory_orders(id int PRIMARY KEY,site_id int,item_category text,item_name text,unit text,
      qty_ordered numeric,rate numeric,discount_pct numeric DEFAULT 0,discount_amount numeric DEFAULT 0,status text);
    INSERT INTO vendor_inventory_orders VALUES
      (1,1,'CEMENT','Cement','bag',10,20,0,0,'partial'),
      (2,1,'BRICKS','Bricks','pcs',100,5,10,0,'open'),
      (3,2,'OTHER','Other site','pcs',1,999,0,0,'open'),
      (4,1,'CANCELLED','Cancelled','pcs',1,1000,0,0,'cancelled');
    CREATE TABLE vendor_inventory_payments(id int PRIMARY KEY,site_id int,order_id int,source_vendor_payment_id int,
      payment_date date,amount numeric,tds_amount numeric DEFAULT 0,payment_mode text,status text,
      cheque_status text,cheque_no text,created_by int);
    INSERT INTO vendor_inventory_payments VALUES
      (1,1,1,NULL,'2026-10-19',100,2,'bank','approved',NULL,NULL,12),
      (2,1,1,NULL,'2026-10-18',30,0,'bank','pending',NULL,NULL,12),
      (3,1,2,NULL,'2026-10-17',50,1,'cash','approved',NULL,NULL,1),
      (4,1,2,NULL,'2026-10-16',100,0,'bank','rejected',NULL,NULL,12),
      (5,2,3,NULL,'2026-10-15',999,0,'bank','approved',NULL,NULL,1);
    CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE sql AS $$
      SELECT $2='approved' AND (UPPER($3)<>'CHEQUE' OR $4='CLEARED')
    $$;
  `);
  if(upgraded)await pg.exec(`
    ALTER TABLE vendor_inventory_orders ADD COLUMN project_id int;
    UPDATE vendor_inventory_orders SET project_id=CASE WHEN id=1 THEN 10 WHEN id=2 THEN 20 END;
    ALTER TABLE construction_projects ADD COLUMN owner_user_id int,ADD COLUMN assigned_approver_id int;
    ALTER TABLE construction_tasks ADD COLUMN owner_user_id int;
    UPDATE construction_projects SET owner_user_id=CASE WHEN id=10 THEN 12 ELSE 99 END;
    INSERT INTO vendor_inventory_orders VALUES(5,1,NULL,'General stock','pcs',1,100,0,0,'partial',NULL);
    INSERT INTO vendor_inventory_payments VALUES(6,1,5,NULL,'2026-10-20',20,0,'bank','approved',NULL,NULL,12);
  `);
  return pg;
}

test('pre-141 stock summary succeeds without project_id and preserves approved/TDS totals',async t=>{
  const pg=await fixture(t);
  const before=await pg.query('SELECT count(*)::int n FROM vendor_inventory_payments');
  const result=await invoke(request(admin));
  assert.equal(result.status,200);
  assert.deepEqual(result.data.totals,{total_items:2,total_value:'650.00',total_paid:'153.00',total_outstanding:'497.00'});
  assert.equal(result.data.categories.length,2);
  assert.equal(result.data.categories.reduce((n,row)=>n+Number(row.total_paid),0),153);
  assert.deepEqual(result.data.recentTransactions.map(row=>row.id),[1,2,3,4]);
  assert.deepEqual((await pg.query('SELECT count(*)::int n FROM vendor_inventory_payments')).rows,before.rows);
});

test('legacy sub-admin reads keep site/creator boundaries and do not require new assignment columns',async t=>{
  await fixture(t);
  const result=await invoke(request(staff,{created_by:'1'}));
  assert.equal(result.status,200);
  assert.equal(result.data.totals.total_paid,'102.00');
  assert.deepEqual(result.data.recentTransactions.map(row=>row.id),[1,2,4]);
  await assert.rejects(invoke(request(staff,{site_id:'2'})),error=>error.statusCode===403);
  await assert.rejects(invoke(request(admin,{site_id:'3'})),error=>error.statusCode===404);
});

test('upgraded stock summary still excludes unassigned projects from all three scoped queries',async t=>{
  await fixture(t,{upgraded:true});
  const scoped=await invoke(request(staff));
  assert.deepEqual(scoped.data.totals,{total_items:2,total_value:'300.00',total_paid:'122.00',total_outstanding:'178.00'});
  assert.deepEqual(scoped.data.categories.map(row=>row.category).sort(),['CEMENT','UNCATEGORIZED']);
  assert.deepEqual(scoped.data.recentTransactions.map(row=>row.id),[6,1,2]);
  const all=await invoke(request(admin));
  assert.equal(all.data.totals.total_value,'750.00');
  assert.equal(all.data.totals.total_paid,'173.00');
});

test('new task-owner assignment authorizes only its project and revocation takes effect immediately',async t=>{
  const pg=await fixture(t,{upgraded:true});
  await pg.exec('UPDATE construction_projects SET owner_user_id=NULL; INSERT INTO construction_tasks VALUES(1,10,12);');
  assert.equal((await invoke(request(staff))).data.totals.total_value,'300.00');
  await pg.exec('DELETE FROM construction_tasks');
  const revoked=await invoke(request(staff));
  assert.equal(revoked.data.totals.total_value,'100.00');
  assert.deepEqual(revoked.data.recentTransactions.map(row=>row.id),[6]);
});
