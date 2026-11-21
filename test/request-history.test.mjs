import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { requestHistoryOptions, createRequestHistoryReader, HISTORY_TABLES } from '../src/services/requestHistory.service.js';

test('history merges pages across modules, preserves cents, and filters the entire archive by status, literal search and IST decision date', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id int,name text,email text); INSERT INTO users VALUES(7,'Reviewer','reviewer@test');
      CREATE TABLE records(id int,source text,status text,entity_name text,amount numeric,approved_by int,approved_at timestamptz,created_at timestamptz);
      INSERT INTO records SELECT n,'expense',CASE WHEN n%2=0 THEN 'approved' ELSE 'rejected' END,
        CASE WHEN n=1 THEN 'Older 50%_ request' ELSE 'Payment '||n END,100.25,7,'2026-11-04T18:00:00Z'::timestamptz+n*interval '1 minute','2026-10-01'
        FROM generate_series(1,30) n;
      INSERT INTO records VALUES(1,'plot_payment','approved','Plot receipt',999.99,7,'2026-11-05T07:00:00Z','2026-10-01'),
        (99,'expense','pending','Still pending',20,NULL,NULL,'2026-11-05');`);
    const load = async query => {
      const options = requestHistoryOptions({ site_id: '1', page_size: '8', ...query });
      const reader = createRequestHistoryReader(db, options);
      for (const module of ['expense','plot_payment']) reader.add('SELECT * FROM records WHERE source=$1',[module]);
      return reader.read();
    };
    const first=await load({}), second=await load({page:'2'}), last=await load({page:'4'});
    assert.equal(first.total,31); assert.equal(first.rows.length,8); assert.equal(last.rows.length,7);
    assert.equal(first.rows[0].source,'plot_payment'); assert.equal(first.rows[0].amount,'999.99');
    assert.equal(first.rows[0].history_decided_by_name,'Reviewer');
    assert.ok(first.rows.every(row=>row.can_decide===false));
    assert.equal(new Set([...first.rows,...second.rows].map(row=>`${row.source}:${row.id}`)).size,16);
    assert.equal((await load({status:'accepted'})).total,16); assert.equal((await load({status:'rejected'})).total,15);
    const found=await load({q:'50%_'}); assert.equal(found.total,1); assert.equal(found.rows[0].id,1);
    assert.equal((await load({from:'2026-11-05',to:'2026-11-05'})).total,2,'18:30 UTC belongs to the next IST date');
    assert.equal((await load({page:'8'})).total,31,'empty pages retain the complete match count');
    assert.equal((await load({page:'8'})).rows.length,0);
  } finally { await db.close(); }
});

test('invalid site, pagination, status, reversed dates and impossible calendar dates fail before querying', () => {
  for(const query of [{site_id:''},{site_id:'1 OR 1=1'},{site_id:'1',page:'0'},{site_id:'1',page_size:'200'},
    {site_id:'1',status:'pending'},{site_id:'1',from:'2026-02-30'},{site_id:'1',from:'2026-11-05',to:'2026-11-04'},{site_id:'1',q:'a'.repeat(201)},
    {site_id:'1',source:['expense']},{site_id:'1',q:{value:'query'}}]) {
    assert.throws(()=>requestHistoryOptions(query),error=>error.statusCode===400);
  }
});

test('financial history preserves site, organisation and requester/reviewer access and never grants decision controls', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id int,name text,organization_id int); CREATE TABLE user_sites(user_id int,site_id int);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean);
      CREATE TABLE users(id int,name text,email text); CREATE TABLE members(id int,full_name text,member_type text);
      CREATE TABLE expenses(id int,site_id int,status text,date date,assigned_admin_id int,created_by int,assigned_user_id int,
        to_entity text,from_entity text,category text,debit numeric,credit numeric,remark text,payment_mode text,voucher_url text,approved_by int,approved_at timestamptz);
      INSERT INTO sites VALUES(1,'Site A',1),(2,'Other site',1),(3,'Other org',2); INSERT INTO user_sites VALUES(5,1);
      INSERT INTO users VALUES(5,'Viewer','viewer@test'),(6,'Other person','other@test'),(7,'Reviewer','reviewer@test');
      INSERT INTO expenses(id,site_id,status,date,created_by,assigned_admin_id,debit,approved_by,approved_at) VALUES
        (1,1,'approved',CURRENT_DATE,5,7,100,7,'2026-11-04'),(2,1,'rejected',CURRENT_DATE,6,5,200,5,'2026-11-05'),
        (3,1,'approved',CURRENT_DATE,6,7,300,7,'2026-11-03'),(4,2,'approved',CURRENT_DATE,5,5,400,5,'2026-11-02'),
        (5,3,'approved',CURRENT_DATE,5,5,500,5,'2026-11-01'),(6,1,'pending',CURRENT_DATE,5,5,600,NULL,NULL);`);
    let readable=true;
    const source=readFileSync(new URL('../src/controllers/approval.controller.js',import.meta.url),'utf8')
      .replace(/^import[\s\S]*?;\n/gm,'').replace(/export const /g,'const ');
    const context={console,asyncHandler:fn=>fn,requestHistoryOptions,HISTORY_TABLES,createRequestHistoryReader:(...args)=>{
      const reader=createRequestHistoryReader(...args);
      return {...reader,add(sql,...rest){if(/FROM expenses e\b/.test(sql))reader.add(sql,...rest);}};
    },
      operationalHistorySources:async()=>[],hasRelation:async()=>false,hasRelations:async()=>new Map(),
      permissionModel:{getPermissions:async()=>new Map()},documentationPermission:async(_actor,source)=>readable&&source==='expense',
      attachModuleChequeDates:async()=>{},signApprovalVoucherLinks:async rows=>rows,
      pool:{query:async(sql,params)=>/FROM (expenses e|sites s|user_sites us)\b/.test(sql)?db.query(sql,params):{rows:[]}}};
    vm.createContext(context);vm.runInContext(`${source}\nthis.readHistory=listRequestHistory;`,context);
    const load=async(role='sub_admin',siteId='1')=>{
      let status=200,body;
      await context.readHistory({user:{id:5,role,organization_id:1},assignedApprovalsOnly:role==='sub_admin',query:{site_id:siteId,module:'expense'}},
        {set(){return this},status(value){status=value;return this},json(value){body=value;}});
      return {status,body};
    };
    let result=await load();assert.deepEqual(Array.from(result.body.entries,row=>row.id),[2,1]);
    assert.ok(result.body.entries.every(row=>row.can_decide===false));
    readable=false; assert.deepEqual(Array.from((await load()).body.entries,row=>row.id),[2]);
    assert.equal((await load('sub_admin','2')).status,403);assert.equal((await load('sub_admin','3')).status,403);
    assert.equal((await load('admin','3')).status,403);assert.equal((await load('super_admin','3')).status,200);
    assert.deepEqual(Array.from((await load('admin')).body.entries,row=>row.id),[2,1,3]);
  } finally { await db.close(); }
});

test('operational history keeps selected staff visibility, personal wallet access and edit ownership without duplicate requests', async () => {
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id int,name text);INSERT INTO sites VALUES(1,'Site A'),(2,'Site B');
      CREATE TABLE users(id int,name text);INSERT INTO users VALUES(5,'Viewer'),(6,'Selected staff'),(7,'Other staff');
      CREATE TABLE members(id int,full_name text);
      CREATE TABLE edit_requests(id int,site_id int,requested_by int,reviewed_by int,module text,status text,original_data jsonb,proposed_data jsonb);
      INSERT INTO edit_requests VALUES(1,1,5,7,'expense','approved','{}','{}'),(2,1,6,7,'expense','rejected','{}','{}'),(3,2,5,7,'expense','approved','{}','{}');
      CREATE TABLE imprest_expense_requests(id int,site_id int,sub_admin_id int,assigned_admin_id int,status text,amount numeric);
      INSERT INTO imprest_expense_requests VALUES(1,1,5,7,'APPROVED',100),(2,1,6,5,'REJECTED',200),(3,1,7,6,'APPROVED',300),(4,2,5,5,'APPROVED',400);
      CREATE TABLE loyalty_vault_transfers(id uuid,site_id int,organization_id int,sender_id int,recipient_id int,from_holder_type text,from_holder_id int,status text,amount numeric,note text);
      INSERT INTO loyalty_vault_transfers VALUES('10000000-0000-0000-0000-000000000001',1,1,5,6,'user',5,'accepted',50,'own transfer'),
        ('10000000-0000-0000-0000-000000000002',1,1,6,7,'user',6,'rejected',60,'private transfer'),
        ('10000000-0000-0000-0000-000000000003',2,1,5,6,'user',5,'accepted',70,'other site');`);
    let personal=true,management=false,wallet=true,walletAll=false;
    const source=readFileSync(new URL('../src/services/operationalRequestHistory.service.js',import.meta.url),'utf8')
      .replace(/^import[\s\S]*?;\n/gm,'').replace('export async function','async function');
    const context={hasRelation:async name=>['edit_requests','imprest_expense_requests','loyalty_vault_transfers'].includes(name),
      permissionModel:{getPermission:async(_id,module)=>({can_read:module==='imprest'?personal:management})},
      withWalletVisibility:async actor=>({...actor,wallet_can_read:wallet,wallet_view_all:walletAll}),
      canViewAllWallets:actor=>['admin','super_admin'].includes(actor.role)||actor.wallet_view_all,
      visibleImprestPeople:async()=>[6]};
    vm.createContext(context);vm.runInContext(`${source}\nthis.sources=operationalHistorySources;`,context);
    const load=async(role='sub_admin')=>{
      const rows=[];
      for(const query of await context.sources(db,{id:5,role,organization_id:1},1))rows.push(...(await db.query(query.sql,query.params)).rows);
      return rows;
    };
    let rows=await load();
    assert.deepEqual(rows.filter(row=>row.source==='edit_request').map(row=>row.id),[1]);
    assert.deepEqual(rows.filter(row=>row.source==='imprest').map(row=>row.id).sort((a,b)=>a-b),[1,2]);
    assert.equal(rows.filter(row=>row.source==='wallet_transfer').length,1);
    personal=false;management=true;
    rows=await load();assert.deepEqual(rows.filter(row=>row.source==='imprest').map(row=>row.id),[2]);
    wallet=false;management=false;
    rows=await load();assert.deepEqual(rows.map(row=>row.source),['edit_request'],'revocation immediately removes wallet and imprest records');
    wallet=true;
    rows=await load('admin');
    assert.equal(rows.filter(row=>row.source==='edit_request').length,2);
    assert.equal(rows.filter(row=>row.source==='imprest').length,3);
    assert.equal(rows.filter(row=>row.source==='wallet_transfer').length,2);
    assert.equal(new Set(rows.map(row=>`${row.source}:${row.id}`)).size,rows.length);
  } finally {await db.close();}
});

test('Imprest history counts each approved request and its recorded handover once before paging', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE sites(id int,name text);
      CREATE TABLE users(id int,name text,email text);
      CREATE TABLE imprest_expense_requests(id int PRIMARY KEY,site_id int,sub_admin_id int,assigned_admin_id int,
        status text,amount numeric,request_type text,reviewed_by int,reviewed_at timestamptz,created_at timestamptz);
      CREATE TABLE imprest_allocations(id int PRIMARY KEY,site_id int,sub_admin_id int,admin_id int,assigned_admin_id int,
        status text,amount numeric,confirmed_at timestamptz,created_at timestamptz);
      CREATE TABLE imprest_ledger(id int PRIMARY KEY,site_id int,user_id int,reference_id int,type text,amount numeric,
        created_by int,remarks text);
      INSERT INTO sites VALUES (1,'DG Associates'),(2,'Different site');
      INSERT INTO users VALUES (5,'Admin'),(6,'Staff'),(7,'Reviewer');
      INSERT INTO imprest_expense_requests VALUES
        (43,1,6,7,'APPROVED',100000,'IMPREST',5,'2026-11-19T12:15:00Z','2026-11-19T12:00:00Z'),
        (44,1,6,7,'APPROVED',100000,'IMPREST',7,'2026-11-19T12:16:00Z','2026-11-19T12:00:00Z');
      INSERT INTO imprest_allocations VALUES
        (104,1,6,5,7,'RECEIVED',100000,'2026-11-19T12:15:00Z','2026-11-19T12:15:00Z'),
        (105,1,6,7,7,'RECEIVED',100000,'2026-11-19T12:16:00Z','2026-11-19T12:16:00Z'),
        (106,1,6,5,7,'RECEIVED',100000,'2026-11-19T12:15:00Z','2026-11-19T12:15:00Z'),
        (107,2,6,5,7,'RECEIVED',100000,'2026-11-19T12:15:00Z','2026-11-19T12:15:00Z');
      INSERT INTO imprest_ledger VALUES
        (1186,1,6,104,'ALLOCATION',100000,5,'Imprest allocated (request #43 approved): site expense'),
        (1187,1,6,105,'TRANSFER_IN',100000,7,'Imprest request #44 funded by Reviewer.'),
        (1188,1,6,106,'ALLOCATION',100000,5,'Direct handover'),
        (1189,2,6,107,'ALLOCATION',100000,5,'Imprest allocated (request #43 approved): other site');
    `);
    const source = readFileSync(new URL('../src/services/operationalRequestHistory.service.js', import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?;\n/gm, '').replace('export async function', 'async function');
    const context = {
      hasRelation: async name => ['imprest_expense_requests', 'imprest_allocations', 'imprest_ledger'].includes(name),
      permissionModel: { getPermission: async (_id, module) => ({ can_read: module === 'imprest' }) },
      withWalletVisibility: async actor => ({ ...actor, wallet_can_read: false }),
      canViewAllWallets: () => false,
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.sources=operationalHistorySources;`, context);
    const load = async (query, actor = { id: 5, role: 'admin' }) => {
      const options = requestHistoryOptions({ site_id: '1', view: 'summary', ...query });
      const reader = createRequestHistoryReader(db, options);
      for (const { sql, params } of await context.sources(db, actor, options.siteId, options)) reader.add(sql, params);
      return reader.read();
    };
    const pages = [];
    for (const page of [1, 2, 3]) {
      const result = await load({ page_size: 1, page });
      assert.equal(result.total, 3);
      pages.push(...result.rows);
    }
    assert.deepEqual(pages.map(row => `${row.source}:${row.id}`).sort(), ['imprest:43', 'imprest:44', 'imprest_allocation:106']);
    const detail = (await load({ source: 'imprest', record_id: '43', view: 'full' })).rows[0];
    assert.equal(detail.imprest_handover.id, 104);
    assert.equal(detail.imprest_handover.sender_name, 'Admin');
    assert.equal(pages.find(row => row.id === 43).imprest_handover.id, 104);
    assert.deepEqual((await load({ source: 'imprest_allocation' })).rows.map(row => row.id).sort(), [104, 105, 106]);
    const sender = await load({}, { id: 5, role: 'sub_admin' });
    assert.deepEqual(sender.rows.map(row => row.id).sort(), [104, 106], 'a sender can keep seeing a handover when the request is outside their visibility');
    const recipient = await load({}, { id: 6, role: 'sub_admin' });
    assert.equal(recipient.total, 3);
    assert.deepEqual((await load({ site_id: '2' })).rows.map(row => row.id), [107]);
  } finally {
    await db.close();
  }
});

test('user filters search authorised request participants before pagination and totals, independently of customer names', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id int,name text,email text);
      CREATE TABLE records(id int,source text,status text,entity_name text,requested_by_name text,created_by_name text,assigned_admin_name text,approved_at timestamptz);
      INSERT INTO records SELECT n,'plot_payment','approved','Tarun Kumar',CASE WHEN n%2=0 THEN 'Ravi Siwach' ELSE 'Other requester' END,
        'Original creator','Kuldeep Tomar','2026-11-05'::timestamptz+n*interval '1 minute' FROM generate_series(1,30) n;`);
    const load = async query => {
      const reader = createRequestHistoryReader(db, requestHistoryOptions({ site_id: '1', page_size: '3', ...query }));
      reader.add('SELECT * FROM records');
      return reader.read();
    };
    const first = await load({ requested_by: 'ravi', assigned_to: 'TOMAR' });
    const next = await load({ requested_by: 'ravi', assigned_to: 'TOMAR', page: '2' });
    assert.equal(first.total, 15); assert.equal(first.rows.length, 3);
    assert.equal(next.total, 15); assert.equal(next.rows.length, 3);
    assert.ok([...first.rows, ...next.rows].every(row => row.requested_by_name === 'Ravi Siwach'));
    assert.equal(new Set([...first.rows, ...next.rows].map(row => row.id)).size, 6);
    assert.equal((await load({ requested_by: 'Tarun' })).total, 0, 'customer names never become requesters');
    assert.equal((await load({ requested_by: 'Original creator' })).total, 0, 'explicit requester takes precedence');
    assert.equal((await load({ assigned_to: "Tomar' OR true --" })).total, 0, 'names remain literal bound values');
    assert.throws(() => requestHistoryOptions({ site_id: '1', requested_by: 'x'.repeat(121) }), error => error.statusCode === 400);
  } finally { await db.close(); }
});

test('summary history retains participant filter columns while pruning other payload fields', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id int,name text,email text);
      CREATE TABLE expenses(id int,status text,created_by_name text,assigned_admin_name text,admin_name text,approved_at timestamptz);
      INSERT INTO expenses VALUES(1,'approved','Ravi','Kuldeep','Ravi','2026-11-15'),(2,'approved','Other user','Kuldeep','Other user','2026-11-14');`);
    const reader = createRequestHistoryReader(db, requestHistoryOptions({site_id:'1',view:'summary',requested_by:'Ravi',assigned_to:'Kuldeep'}));
    reader.add("SELECT e.*, 'expense'::text AS source FROM expenses e", [], row=>row, 'expense');
    const result = await reader.read();
    assert.equal(result.total,1); assert.equal(result.rows[0].id,1);
    assert.equal(result.rows[0].created_by_name,'Ravi'); assert.equal(result.rows[0].assigned_admin_name,'Kuldeep');
    assert.equal(result.rows[0].history_summary,true);
  } finally {await db.close();}
});

test('site transfer history follows both sites and both participants, including older decisions searched by ledger or reference', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,name text);
      CREATE TABLE users(id int PRIMARY KEY,name text,email text);
      CREATE TABLE site_money_transfers(id int PRIMARY KEY,organization_id int,source_site_id int,destination_site_id int,
        requested_by int,approver_id int,status text,amount numeric,mode text,source_ledger_name text,destination_ledger_name text,
        transfer_date date,created_at timestamptz NOT NULL,decided_by int,decided_at timestamptz,decision_note text);
      INSERT INTO sites VALUES (1,'OM Associates'),(2,'DG Associates'),(3,'Other site');
      INSERT INTO users VALUES (5,'Requester','a@example.test'),(6,'Approver','b@example.test'),(7,'Unrelated','c@example.test');
      INSERT INTO site_money_transfers SELECT n,1,1,2,5,6,
        CASE n WHEN 2 THEN 'rejected' WHEN 3 THEN 'pending' WHEN 4 THEN 'cancelled' ELSE 'approved' END,
        500000,'cash',CASE WHEN n=1 THEN 'Old debit ledger' ELSE 'Cash ledger' END,'Project ledger',
        '2026-11-01'::date,'2026-11-01'::timestamptz,6,'2026-11-01'::timestamptz+n*interval '1 day',
        CASE WHEN n=2 THEN 'Incorrect ledger' END FROM generate_series(1,30) n;`);
    const source = readFileSync(new URL('../src/services/operationalRequestHistory.service.js', import.meta.url), 'utf8')
      .replace(/^import[\s\S]*?;\n/gm, '').replace('export async function', 'async function');
    const context = { hasRelation: async name => name === 'site_money_transfers' };
    vm.createContext(context);
    vm.runInContext(source, context);
    const load = async (filters = {}, id = 5, organizationId = 1) => {
      const options = requestHistoryOptions({ site_id: 1, source: 'site_money_transfer', view: 'summary', ...filters });
      const reader = createRequestHistoryReader(db, options);
      for (const { sql, params } of await context.operationalHistorySources(db, { id, role: 'sub_admin', organization_id: organizationId }, options.siteId, options)) {
        reader.add(sql, params);
      }
      return reader.read();
    };
    assert.equal((await load()).total, 28);
    assert.equal((await load({ site_id: 2 }, 6)).total, 28);
    assert.equal((await load({ site_id: 3 })).total, 0);
    assert.equal((await load({}, 7)).total, 0);
    assert.equal((await load({}, 5, 2)).total, 0);
    const older = await load({ q: 'Old debit ledger', pagination: 'cursor' });
    assert.equal(older.rows[0].id, 1);
    assert.equal(older.rows[0].destination_ledger_name, 'Project ledger');
    assert.equal(older.rows[0].requested_by_name, 'Requester');
    const refused = await load({ status: 'rejected', q: 'SMT-2', view: 'full' }, 6);
    assert.equal(refused.total, 1);
    assert.equal(refused.rows[0].decision_note, 'Incorrect ledger');
    assert.equal(refused.rows[0].history_decided_by_name, 'Approver');
    assert.equal(refused.rows[0].can_decide, false);
  } finally { await db.close(); }
});
