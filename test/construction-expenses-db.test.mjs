import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { expenseModel } from '../src/models/Expense.model.js';
import { constructionExpenseScope, vendorExpenseCreationConflict } from '../src/services/constructionExpenseScope.service.js';
import { createExpense } from '../src/controllers/expense.controller.js';
const scope = { only_site: 'true', include_vendor:true,vendor_user_id:1,vendor_all:true,vendor_site_all:true,vendor_rows_all:true };
async function fixture(t) {
  // All rows and trigger failures live in this isolated engine. Never open the
  // configured application database or write a customer financial record.
  const pg = new PGlite();
  const oldQuery = pool.query, oldConnect = pool.connect;
  const query = (sql, params) => pg.query(sql, params);
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  t.after(async () => { pool.query = oldQuery; pool.connect = oldConnect; await pg.close(); });
  await pg.exec(`
    CREATE TABLE sites(id integer PRIMARY KEY, name text, city text, state text);
    INSERT INTO sites VALUES (5, 'OM Associates', '', ''), (7, 'Other site', '', '');
    CREATE TABLE users(id integer PRIMARY KEY, name text, email text);
    INSERT INTO users VALUES (1, 'Administrator', 'admin@example.test'), (12, 'Sunny', 'sunnys@gmail.com');
    CREATE TABLE members(id integer PRIMARY KEY, site_id integer REFERENCES sites(id), full_name text, phone text);
    INSERT INTO members VALUES (20, 5, 'Linked client', '9999999999'),
      (21, 5, 'Replacement client', '8888888888'), (22, 7, 'Other-site client', '7777777777');
    CREATE TABLE expenses(id serial PRIMARY KEY, site_id integer, date date, from_entity text, to_entity text,
      payment_mode text, debit numeric DEFAULT 0, credit numeric DEFAULT 0, remark text, account_no text,
      branch text, category text, sub_category text, assigned_user_id integer, assigned_admin_id integer,
      voucher_urls text[], voucher_url text, bill_urls text[], bill_url text, status text, created_by integer,
      approved_by integer, approved_at timestamptz, cheque_no text, cheque_status text,
      customer_signature_url text, authority_signature_url text, created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(), display_order integer, transaction_time time,
      entry_transfer_id text, entry_transfer_role text, tds_amount numeric, tds_rate numeric,
      tds_mode text, tds_section text, tds_module text, tds_deductee_name text, tds_pan text);
    CREATE TABLE transaction_party_links(source_key varchar(40), source_id integer, site_id integer REFERENCES sites(id),
      member_id integer REFERENCES members(id), direction text CHECK (direction IN ('debit','credit')),
      created_by integer, updated_at timestamptz DEFAULT now(), PRIMARY KEY(source_key, source_id));
    CREATE TABLE ledger_entries(id text, site_id integer, source_key text, source_id integer, ledger_type text, debit numeric, credit numeric);
    INSERT INTO ledger_entries(id,site_id,source_key,source_id,ledger_type,debit,credit) VALUES ('vp_mirror',5,'vendor_payments',9,'site',980.50,0);
    CREATE FUNCTION ledger_bucket(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN upper($1)='CASH' THEN 'cash' ELSE 'bank' END $$;
    CREATE TABLE construction_projects(id integer,name text,site_id integer,created_by integer,owner_user_id integer,assigned_admin_id integer,assigned_approver_id integer);
    CREATE TABLE construction_tasks(project_id integer,owner_user_id integer);
    CREATE TABLE user_sites(user_id integer,site_id integer);
    CREATE FUNCTION financial_transaction_posts(text, text, text, text) RETURNS boolean
      LANGUAGE sql IMMUTABLE AS $$ SELECT $2 = 'approved' $$;
    CREATE TABLE farmers(id integer, site_id integer, name text);
    CREATE TABLE farmer_payments(LIKE expenses, farmer_id integer, amount numeric,
      remarks text, bank_account_no text, bank_ifsc text);
    CREATE TABLE plots(id integer, plot_no text);
    CREATE TABLE plot_commissions_v2(id integer, plot_id integer, agent_id integer);
    CREATE TABLE plot_commission_payments(LIKE expenses, plot_commission_id integer, amount numeric, remarks text);
    CREATE TABLE vendor_commitments(id integer, vendor_name text,site_id integer,project_id integer,work_title text);
    CREATE TABLE vendor_payments(LIKE expenses, commitment_id integer, amount numeric, payment_date date, note text);
    CREATE TABLE cash_flow_months(id integer, ledger_type text);
    CREATE TABLE cash_flow_entries(LIKE expenses, cash_flow_month_id integer, to_name text, particular text,
      remarks text, cash_type text, source_module text);
    CREATE TABLE day_book(LIKE expenses, particular text, remarks text, entry_type text,
      farmer_payment_id integer, commission_id integer, vendor_payment_id integer);
  `);
  return { pg, query };
}


async function seed(pg) {
 await pg.exec(`INSERT INTO construction_projects VALUES(2,'Road Making in Unn Plaza',5,1,12,1,1),(3,'Private project',5,1,99,1,1);
 INSERT INTO user_sites VALUES(12,5),(99,7);
 INSERT INTO vendor_commitments VALUES(4,'Road Vendor',5,2,'Road construction'),(5,'Hidden Vendor',5,3,'Private scope');
 INSERT INTO vendor_payments(id,site_id,commitment_id,payment_date,amount,payment_mode,status,created_by,note) VALUES
 (9,5,4,'2026-10-19',1000,'cash','approved',1,'First milestone'),
 (10,5,4,'2026-10-19',250,'cheque','pending',1,'Pending cheque'),
 (11,5,5,'2026-10-19',50,'bank','pending',1,'Hidden');
 INSERT INTO expenses(site_id,date,debit,payment_mode,status,created_by,category) VALUES(5,'2026-10-19',20,'CASH','approved',1,'FOOD');`);
}

test('Expenses shows the same vendor source once, with canonical ledger contribution and source detail', async t => {
 const {pg,query}=await fixture(t); await seed(pg);
 const page=await expenseModel.findPaginatedUnified(5,scope,1,0,{query});
 assert.equal(page.totalItems,4);
 const vendor=page.items.find(row=>row.id==='vp_9');
 assert.equal(vendor.original_id,9); assert.equal(vendor.commitment_id,4); assert.equal(vendor.project_id,2);
 assert.equal(vendor.project_name,'Road Making in Unn Plaza'); assert.equal(vendor.ledger_id,'vp_mirror');
 assert.equal(vendor.posted_debit,'980.50'); assert.equal(Number(page.summary.total_debit),1000.5);
 assert.equal((await query('SELECT count(*)::int AS n FROM expenses')).rows[0].n,1);
 const breakdown=await expenseModel.getUnifiedBreakdowns(5,scope,{query});
 assert.equal(Number(breakdown.categoryBreakdown.find(row=>row.category==='VENDOR PAYMENT').total_debit),980.5);
 assert.equal(Number(breakdown.modeBreakdown.reduce((sum,row)=>sum+Number(row.total_debit),0)),1000.5);
});

test('payment ID/search/status/date filters agree across list, totals, breakdown and export scope', async t => {
 const {pg,query}=await fixture(t); await seed(pg);
 const filters={...scope,vendor_payment_id:9,search:'Unn Plaza',status:'approved',dateFrom:'2026-10-19',dateTo:'2026-10-19'};
 const page=await expenseModel.findPaginatedUnified(5,filters,1,20,{query});
 assert.equal(page.totalItems,1);assert.equal(page.items[0].id,'vp_9');assert.equal(Number(page.summary.total_debit),980.5);
 const br=await expenseModel.getUnifiedBreakdowns(5,filters,{query});
 assert.equal(br.categoryBreakdown.length,1);assert.equal(Number(br.categoryBreakdown[0].total_debit),980.5);
 const pending=await expenseModel.findPaginatedUnified(5,{...scope,status:'pending'},1,0,{query});
 assert.equal(pending.totalItems,2);assert.equal(Number(pending.summary.total_debit),0);
});

test('sub-admin project assignment and site membership constrain vendor list and aggregate equally', async t => {
 const {pg,query}=await fixture(t);await seed(pg);
 const userScope={...scope,vendor_user_id:12,vendor_all:false,vendor_site_all:false};
 const page=await expenseModel.findPaginatedUnified(5,userScope,1,0,{query});
 assert.deepEqual(page.items.filter(row=>row.source==='vendor_payment').map(row=>row.original_id).sort(),[10,9].sort());
 const outsider=await expenseModel.findPaginatedUnified(5,{...userScope,vendor_user_id:99,vendor_all:true},1,0,{query});
 assert.equal(outsider.items.filter(row=>row.source==='vendor_payment').length,0);
 const denied=await expenseModel.findPaginatedUnified(5,{...scope,include_vendor:false},1,0,{query});
 assert.equal(denied.items.filter(row=>row.source==='vendor_payment').length,0);
});

test('ordinary expense creation refuses reserved vendor representations before any insert', async () => {
 assert.equal(vendorExpenseCreationConflict({category:'vendor payment'}),true);
 assert.equal(vendorExpenseCreationConflict({source_vendor_payment_id:9}),true);
 assert.equal(vendorExpenseCreationConflict({category:'FOOD'}),false);
 const result=await new Promise((resolve,reject)=>createExpense({body:{site_id:5,category:'VENDOR PAYMENT'},user:{id:1,role:'admin'}},{status(code){this.code=code;return this;},json(body){resolve({code:this.code,body});}},reject));
 assert.equal(result.code,409);assert.match(result.body.message,/automatically/);
 assert.deepEqual(await constructionExpenseScope({id:1,role:'super_admin'}),{vendor_user_id:1,vendor_all:true,vendor_site_all:true,vendor_rows_all:true,include_vendor:true});
});

// Exercise the schema boundary as well as SQL: the browser cannot supply the
// internal vendor scope, and GraphQL normalization must retain source filters.
test('GraphQL Expenses preserves source identity, receipt type and identical filtered ledger totals',async t=>{
 const {graphql}=await import('graphql');
 const {schema}=await import('../src/graphql/schema.js');
 const {verifyReceiptToken}=await import('../src/utils/receiptToken.js');
 const oldCache=process.env.CACHE_ENABLED;process.env.CACHE_ENABLED='false';
 t.after(()=>{if(oldCache===undefined)delete process.env.CACHE_ENABLED;else process.env.CACHE_ENABLED=oldCache;});
 const {pg}=await fixture(t);await seed(pg);
 const result=await graphql({schema,source:`query {
  expensesPageData(siteId:5,limit:0,includeBreakdowns:true,filters:{vendorPaymentId:9,search:"Unn Plaza",status:"approved",mode:"CASH",dateFrom:"2026-10-19",dateTo:"2026-10-19"}) {
   expenses {id source original_id commitment_id project_id project_name vendor_name work_title posted_debit posted_credit ledger_id verifyUrl}
   summary {total_debit total_credit total_count} pagination {totalItems}
   modeBreakdown {payment_mode total_debit} categoryBreakdown {category total_debit}
  }
  expensesBreakdown(siteId:5,filters:{vendorPaymentId:9,search:"Unn Plaza",status:"approved",mode:"CASH",dateFrom:"2026-10-19",dateTo:"2026-10-19"}) {categoryBreakdown {category total_debit}}
 }`,contextValue:{user:{id:1,role:'admin',organization_id:1}}});
 assert.equal(result.errors,undefined,JSON.stringify(result.errors));
 const page=result.data.expensesPageData;assert.equal(page.expenses.length,1);assert.equal(page.pagination.totalItems,1);
 const vendor=page.expenses[0];assert.equal(vendor.id,'vp_9');assert.equal(vendor.source,'vendor_payment');assert.equal(vendor.original_id,9);assert.equal(vendor.commitment_id,4);assert.equal(vendor.project_id,2);assert.equal(vendor.project_name,'Road Making in Unn Plaza');assert.equal(vendor.posted_debit,'980.50');assert.equal(vendor.ledger_id,'vp_mirror');
 assert.equal(page.summary.total_debit,980.5);assert.equal(page.modeBreakdown[0].total_debit,980.5);assert.equal(page.categoryBreakdown[0].total_debit,980.5);assert.equal(result.data.expensesBreakdown.categoryBreakdown[0].total_debit,980.5);
 const token=verifyReceiptToken(new URL(vendor.verifyUrl).searchParams.get('token'));assert.equal(token.valid,true);assert.equal(token.payload.t,'VND');assert.equal(token.payload.i,9);
 assert.equal((await pg.query('SELECT count(*)::int n FROM expenses')).rows[0].n,1);
});

test('GraphQL Expenses applies current module/site grants and ignores attempts to widen creator scope',async t=>{
 const {graphql}=await import('graphql');const {schema}=await import('../src/graphql/schema.js');
 const oldCache=process.env.CACHE_ENABLED;process.env.CACHE_ENABLED='false';t.after(()=>{if(oldCache===undefined)delete process.env.CACHE_ENABLED;else process.env.CACHE_ENABLED=oldCache;});
 const {pg}=await fixture(t);await seed(pg);
 await pg.exec(`CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean,PRIMARY KEY(user_id,module));
  INSERT INTO user_permissions VALUES(12,'vendors',true,false),(12,'construction',true,false);`);
 const query=`query {expensesPageData(siteId:5,limit:0,filters:{createdBy:1,vendorPaymentId:9}) {expenses{id source} summary{total_debit}}}`;
 const context={user:{id:12,role:'sub_admin',organization_id:1},siteIds:new Set([5]),permissions:new Map([['expenses',{can_read:true,can_view_all:false}]])};
 const restricted=await graphql({schema,source:query,contextValue:context});assert.equal(restricted.errors,undefined,JSON.stringify(restricted.errors));assert.equal(restricted.data.expensesPageData.expenses.length,0);assert.equal(restricted.data.expensesPageData.summary.total_debit,0);
 const allExpenses={...context,permissions:new Map([['expenses',{can_read:true,can_view_all:true}]])};
 const sourceRestricted=await graphql({schema,source:query,contextValue:allExpenses});assert.equal(sourceRestricted.errors,undefined,JSON.stringify(sourceRestricted.errors));assert.equal(sourceRestricted.data.expensesPageData.expenses.length,0);
 await pg.query("UPDATE user_permissions SET can_view_all=true WHERE user_id=12 AND module='vendors'");
 const assigned=await graphql({schema,source:query,contextValue:allExpenses});assert.equal(assigned.errors,undefined,JSON.stringify(assigned.errors));assert.equal(assigned.data.expensesPageData.expenses[0].id,'vp_9');
 await pg.query("UPDATE user_permissions SET can_read=false WHERE user_id=12 AND module='vendors'");
 const deniedModule=await graphql({schema,source:query,contextValue:allExpenses});assert.equal(deniedModule.errors,undefined);assert.equal(deniedModule.data.expensesPageData.expenses.length,0);
 const deniedSite=await graphql({schema,source:query,contextValue:{...allExpenses,siteIds:new Set([7])}});assert.equal(deniedSite.errors[0].extensions.code,'FORBIDDEN');
 const deniedExpenses=await graphql({schema,source:query,contextValue:{...context,permissions:new Map()}});assert.equal(deniedExpenses.errors[0].extensions.code,'FORBIDDEN');
 const spoof=await graphql({schema,source:`query{expensesPageData(siteId:5,filters:{vendor_all:true}){pagination{totalItems}}}`,contextValue:allExpenses});assert.match(spoof.errors[0].message,/not defined/);
});
