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
