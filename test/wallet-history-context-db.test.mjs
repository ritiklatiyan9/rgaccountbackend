import { walletHistoryParentsSql } from './helpers/walletHistoryParents.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { history, historyDetail, transfers } from '../src/controllers/loyaltyVault.controller.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';

test('wallet history preserves module descriptions, transfer parties and site-only custody', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const originalQuery = pool.query, originalConnect = pool.connect;
  pool.query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1);
  pool.connect = async () => ({ query: pool.query, release() {} });
  const invoke = (handler = history, query = {}, params = {}, id = 1) => new Promise((resolve, reject) => handler({
    user: { id }, authenticatedUser: { id, role: id === 1 ? 'admin' : 'sub_admin', organization_id: 1, is_active: true },
    query: { site_id: 10, ...query }, params,
  }, { set() { return this; }, json: resolve }, reject));
  try {
    await pg.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean);
      INSERT INTO users VALUES(1,'Ravi','admin',1,true),(2,'Kuldeep','sub_admin',1,true);
      CREATE TABLE members(id int PRIMARY KEY,full_name text,site_id int);
      CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int); INSERT INTO sites VALUES(10,'Main project',1),(11,'Other project',1);
      CREATE TABLE user_sites(user_id int,site_id int); INSERT INTO user_sites VALUES(2,10);
      CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean);
      CREATE TABLE loyalty_vault_transfers(id uuid PRIMARY KEY,from_holder_type text,from_holder_id int,to_holder_id int,
        status text,note text,created_at timestamptz,resolved_at timestamptz,resolved_by int,resolution_note text);
      CREATE TABLE loyalty_vault_entries(id serial PRIMARY KEY,organization_id int,site_id int,holder_key text,holder_type text,
        holder_id int,actor_id int,amount numeric,balance_after numeric,kind text,description text,source_table text,
        source_id int,cash_flow_entry_id int,transfer_id uuid,details jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
      CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_name text,block text);
      CREATE TABLE plot_installments(id int PRIMARY KEY,plot_id int);
      CREATE FUNCTION loyalty_vault_source_site(source_table text,source jsonb) RETURNS int LANGUAGE sql STABLE
        AS $$ SELECT NULLIF(source->>'site_id','')::int $$;`);
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) await pg.exec(`CREATE TABLE ${table}(id int PRIMARY KEY,
      description text,particular text,narration text,remark text,remarks text,note text,reference_no text,
      plot_id int,installment_id int,date date,payment_date date,site_id int DEFAULT 10,status text,approved_at timestamptz,approved_by int,created_by int)`);
    await pg.exec(walletHistoryParentsSql);
    await pg.exec(`INSERT INTO expenses(id,remark,reference_no) VALUES(20,'Unused material returned — cash received 15K','EXP-20'),
      (21,'Unrelated expense with no wallet custody','EXP-21');
      INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,actor_id,amount,balance_after,kind,
        description,source_table,source_id,details) VALUES
      (1,10,'user:1','user',1,1,15000,15000,'credit','Expense cash receipt','expenses',20,'{"payment_mode":"CASH"}'),
      (1,11,'user:1','user',1,1,90000,105000,'credit','Other site custody','expenses',21,'{}'),
      (1,10,'user:1','user',1,1,500,105500,'credit','Saved receipt','expenses',22,
        '{"source_description":"Original recorded particulars 100%", "remarks":"Saved receipt note", "reference":"EXP-22"}');
      INSERT INTO loyalty_vault_transfers VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','user',1,2,'accepted','Expense refund handover',now(),now(),2,'Cash received');
      INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,actor_id,amount,balance_after,kind,
        description,transfer_id) VALUES
      (1,10,'user:1','user',1,2,-10000,95500,'transfer_out','Cash handed over','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      (1,10,'user:2','user',2,2,10000,10000,'transfer_in','Cash received','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');`);

    await pg.exec('UPDATE expenses SET created_by=2 WHERE id=20');
    const result = await invoke();
    assert.equal(result.total, 4, 'source finance rows never appear without a wallet movement');
    const expense = result.entries.find(row => row.source_id === 20);
    assert.equal(expense.created_by_name, 'Kuldeep', 'source creator is distinct from the wallet posting actor');
    assert.equal(expense.actor_name, 'Ravi');
    assert.equal(expense.source_details.source_description, 'Unused material returned — cash received 15K');
    assert.equal(expense.source_details.module_name, 'Expenses');
    assert.equal(expense.source_details.reference, 'EXP-20');
    assert.equal(expense.source_details.source_available, true);
    assert.equal(Number(expense.balance_after), 15000, 'running balance excludes another site');
    const sent = result.entries.find(row => row.kind === 'transfer_out');
    assert.equal(sent.from_holder_name, 'Ravi'); assert.equal(sent.to_holder_name, 'Kuldeep');
    assert.equal(sent.counterparty_name, 'Kuldeep'); assert.equal(sent.transfer_note, 'Expense refund handover');
    assert.equal(sent.resolved_by_name, 'Kuldeep');
    assert.equal((await invoke(history, { q: 'EXP-20' })).total, 1);
    assert.equal((await invoke(history, { q: 'Expenses' })).total, 2);
    assert.equal((await invoke(history, { q: '100%' })).total, 1);
    assert.equal((await invoke(history, { q: '100_' })).total, 0);
    assert.equal((await invoke(history, { q: 'Kuldeep' })).total, 2);
    assert.equal((await invoke(history, { q: 'Unrelated expense' })).total, 0);
    await pg.exec(`UPDATE loyalty_vault_entries SET details=details||'{"status":"pending"}'::jsonb WHERE source_id=20;
      UPDATE expenses SET status='approved',approved_at='2026-10-15T09:26:36Z',approved_by=1 WHERE id=20`);
    const approved=(await invoke(historyDetail,{}, {id:expense.id})).entry;
    assert.equal(approved.current_source_status,'approved');
    assert.equal(approved.approved_by_name,'Ravi');
    assert.equal(approved.created_by_name,'Kuldeep');
    assert.equal(approved.details.status,'pending','immutable posting snapshot is preserved independently');
    assert.ok(approved.current_source_reviewed_at);
    await pg.exec("UPDATE expenses SET status='rejected' WHERE id=20");
    const rejected=(await invoke(historyDetail,{}, {id:expense.id})).entry;
    assert.equal(rejected.current_source_status,'rejected','opening an old credit shows the latest rejection');
    const chronological = await invoke(history, { holder_type: 'user', holder_id: 1, order: 'asc', limit: 1, page: 2 });
    assert.equal(chronological.order, 'asc');
    assert.equal(chronological.total, 3);
    assert.equal(Number(chronological.entries[0].balance_after), 15500, 'pagination retains the earlier opening balance');
    const searched = await invoke(history, { q: 'Kuldeep', holder_type: 'user', holder_id: 1, order: 'asc' });
    assert.equal(Number(searched.entries[0].balance_after), 5500, 'search never resets the running balance');
    assert.equal(Number(searched.totals.credit),0);
    assert.equal(Number(searched.totals.debit),10000,'totals follow the source search and selected holder');
    assert.equal(Number(searched.totals.net),-10000);
    const empty=await invoke(history,{from:'2099-01-01',to:'2099-12-31'});
    assert.deepEqual(empty.totals,{credit:'0',debit:'0',net:'0'});
    await assert.rejects(invoke(history, { order: 'asc; DROP TABLE users' }), error => error.statusCode === 400);

    const removed = result.entries.find(row => row.source_id === 22);
    assert.equal(removed.source_details.source_available, false);
    assert.equal(removed.created_by_name, null, 'missing source creators are not inferred from the wallet holder or posting actor');
    assert.equal(removed.source_details.source_description, 'Original recorded particulars 100%');
    assert.equal(removed.source_details.notes, 'Saved receipt note');
    await pg.exec("INSERT INTO expenses(id,remark) VALUES(22,'Later replacement particulars')");
    assert.equal((await invoke(historyDetail, {}, { id: removed.id })).entry.source_details.source_description,
      'Original recorded particulars 100%', 'saved movement context remains stable after source changes');
    await pg.exec("UPDATE expenses SET site_id=11,remark='Private other project description',reference_no='OTHER-PRIVATE' WHERE id=20");
    const moved = (await invoke(historyDetail, {}, { id: expense.id })).entry;
    assert.equal(moved.source_details.source_description, 'Expense cash receipt');
    assert.equal(moved.source_details.reference, undefined);
    assert.equal(moved.current_source_status,null,'status from another site must not leak');
    assert.equal(moved.current_source_reviewed_at,null);
    assert.equal(moved.created_by_name,null,'creator from another source site must not leak');
    assert.equal(moved.approved_by_name,null,'approver from another source site must not leak');
    assert.equal((await invoke(history, { q: 'OTHER-PRIVATE' })).total, 0, 'moving a source never leaks the new site context');
    const own = await invoke(history, {}, {}, 2);
    assert.equal(own.total, 1); assert.equal(own.entries[0].holder_id, 2);
    await assert.rejects(invoke(historyDetail, {}, { id: expense.id }, 2), error => error.statusCode === 404);
    await assert.rejects(invoke(historyDetail, { site_id: 11 }, { id: expense.id }), error => error.statusCode === 404);
    await pg.exec(`UPDATE loyalty_vault_entries SET created_at=CASE
      WHEN source_id=20 THEN '2026-10-15T18:29:00Z'::timestamptz
      WHEN source_id=22 THEN '2026-11-01T00:00:00Z'::timestamptz
      ELSE '2026-11-02T00:00:00Z'::timestamptz END`);
    const scope={holder_type:'user',holder_id:1,order:'asc',limit:1};
    const day=await invoke(history,{...scope,from:'2026-10-15',to:'2026-10-15'});
    assert.deepEqual(Object.values(day.totals).map(Number),[15000,0,15000],'day totals use the IST date boundary');
    const month=await invoke(history,{...scope,from:'2026-11-01',to:'2026-11-30'});
    assert.equal(month.total,2);assert.equal(month.entries.length,1);
    assert.deepEqual(Object.values(month.totals).map(Number),[500,10000,-9500],'month totals include all pages');
    const year=await invoke(history,{...scope,from:'2026-01-01',to:'2026-12-31'});
    assert.deepEqual(Object.values(year.totals).map(Number),[15500,10000,5500],'year totals exclude the other project');

    await pg.exec(`INSERT INTO farmers VALUES(41,10,'Farmer Harish');
      INSERT INTO firms VALUES(41,10,'Rivergreen Estates');
      INSERT INTO cash_flow_months VALUES(41,10,'Ravi personal account','person');
      INSERT INTO vendor_commitments VALUES(41,10,'Oak Construction','Boundary wall labour');
      INSERT INTO vendor_inventory_orders VALUES(41,10,'Stone Suppliers','Concrete blocks','Materials');
      INSERT INTO land_deals VALUES(41,10,'Land buyer Ajay','Sale East');
      INSERT INTO members VALUES(41,'Agent Meera',10),(42,'Partner Neeraj',10);
      INSERT INTO plots VALUES(41,10,'B7','Plot buyer Anita','B');
      INSERT INTO plot_commissions_v2 VALUES(41,10,41,41);
      INSERT INTO misc_income_categories VALUES(41,'Maintenance');`);
    const parents = {farmer_payments:['farmer_id',41,'Farmer Harish'],firm_transactions:['firm_id',41,'Rivergreen Estates'],
      cash_flow_entries:['cash_flow_month_id',41,'Ravi personal account'],vendor_payments:['commitment_id',41,'Oak Construction'],
      vendor_inventory_payments:['order_id',41,'Stone Suppliers'],land_deal_payments:['land_deal_id',41,'Land buyer Ajay'],
      plot_commission_payments:['plot_commission_id',41,'Agent Meera'],misc_income_entries:['category_id',41,'Income payer'],
      partner_profit_payments:['member_id',42,'Partner Neeraj']};
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) {
      await pg.exec(`ALTER TABLE ${table} ADD COLUMN party_name text, ADD COLUMN category text, ADD COLUMN sub_category text,
        ADD COLUMN from_entity text, ADD COLUMN to_entity text;`);
      const parent=parents[table];
      if(parent) await pg.exec(`ALTER TABLE ${table} ADD COLUMN ${parent[0]} integer;`);
      await pg.query(`INSERT INTO ${table}(id,site_id,description,party_name,category,from_entity,plot_id${parent?`,${parent[0]}`:''})
        VALUES(100,10,$1,$2,$3,$4,41${parent?', $5':''})`,
      [`Detailed ${table} particulars`,table==='misc_income_entries'?'Income payer':null,
        table==='expenses'?'Material refund':null,['expenses','day_book'].includes(table)?'Cash payer':null,...(parent?[parent[1]]:[])]);
      await pg.query(`INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,actor_id,
        amount,kind,description,source_table,source_id) VALUES(1,10,'user:1','user',1,1,10,'credit','Cash receipt',$1,100)`,[table]);
    }
    const moduleRows=(await invoke()).entries.filter(row=>row.source_id===100);
    assert.equal(moduleRows.length,LOYALTY_VAULT_SOURCE_TABLES.size);
    for(const [table,[,,name]] of Object.entries(parents)) assert.equal(moduleRows.find(row=>row.source_table===table).source_details.party_name,name,table);
    assert.equal(moduleRows.find(row=>row.source_table==='expenses').source_details.from_entity,'Cash payer');
    assert.equal(moduleRows.find(row=>row.source_table==='expenses').source_details.category,'Material refund');
    assert.equal(moduleRows.find(row=>row.source_table==='vendor_payments').source_details.work_title,'Boundary wall labour');
    assert.equal(moduleRows.find(row=>row.source_table==='vendor_inventory_payments').source_details.item_name,'Concrete blocks');
    assert.equal(moduleRows.find(row=>row.source_table==='plot_commission_payments').source_details.plot_no,'B7');
    assert.equal((await invoke(history,{q:'Oak Construction'})).total,1,'human names are searchable');
    await pg.exec("UPDATE vendor_commitments SET site_id=11,vendor_name='Private vendor' WHERE id=41");
    const movedVendor=(await invoke()).entries.find(row=>row.source_table==='vendor_payments'&&row.source_id===100);
    assert.equal(movedVendor.source_details.party_name,undefined,'parents from another site are excluded');
    assert.equal((await invoke(history,{q:'Private vendor'})).total,0);

    await pg.exec(`ALTER TABLE sites ADD COLUMN include_in_overall boolean DEFAULT true;
      UPDATE sites SET include_in_overall=false WHERE id=11;
      INSERT INTO users VALUES(3,'Dev','sub_admin',1,true);
      INSERT INTO user_sites VALUES(3,10);
      ALTER TABLE loyalty_vault_transfers ADD COLUMN organization_id int DEFAULT 1,ADD COLUMN site_id int DEFAULT 10,
        ADD COLUMN sender_id int DEFAULT 1,ADD COLUMN recipient_id int,ADD COLUMN amount numeric DEFAULT 10000;
      UPDATE loyalty_vault_transfers SET recipient_id=to_holder_id;
      INSERT INTO loyalty_vault_transfers(id,from_holder_type,from_holder_id,to_holder_id,recipient_id,status,note,amount,site_id,created_at) VALUES
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','user',1,3,3,'accepted','100% office cash',25.10,10,now()),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','user',1,3,3,'pending','Awaiting receipt',70,10,now()),
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','user',1,3,3,'accepted','Off-site cash',999,11,now());`);
    const invokeOverall=(handler,query={},id=1)=>new Promise((resolve,reject)=>handler({
      path:'/overall/history',user:{id},authenticatedUser:{id,role:id===1?'admin':'sub_admin',organization_id:1,is_active:true},query,params:{}
    },{set(){return this;},json:resolve},reject));
    const handovers=await invokeOverall(transfers,{from_id:'1',limit:1});
    assert.equal(handovers.total,3);
    assert.equal(handovers.transfers.length,1);
    assert.equal(Number(handovers.totals.accepted_amount),10025.10,'accepted amounts span all matching pages');
    assert.equal(Number(handovers.totals.pending_amount),70);
    assert.deepEqual(handovers.included_site_ids,[10]);
    assert.deepEqual(handovers.recipient_totals.map(row=>[row.name,Number(row.amount)]),[['Kuldeep',10000],['Dev',25.10]]);
    const dev=await invokeOverall(transfers,{from_id:1,to_id:3,status:'accepted',amount_min:'25',amount_max:'26',q:'100%'});
    assert.equal(dev.total,1);assert.equal(Number(dev.totals.accepted_amount),25.10);
    assert.equal((await invokeOverall(transfers,{q:'100_'})).total,0);
    await assert.rejects(invokeOverall(transfers,{site_id:11}),error=>error.statusCode===403);
    await assert.rejects(invokeOverall(transfers,{},2),error=>error.statusCode===403);
    await assert.rejects(invoke(transfers,{amount_min:'50',amount_max:'20'}),error=>error.statusCode===400);
    const fromRavi=await invokeOverall(history,{from_id:1,to_id:2,amount_min:10000,amount_max:10000});
    assert.equal(fromRavi.total,2,'both posted sides remain separate wallet movements');
    assert.equal(Number(fromRavi.totals.net),0);
    assert.ok(fromRavi.entries.every(row=>row.site_id===10));
    assert.equal((await invoke(history,{module:'expenses',amount_min:'15000',amount_max:'15000'})).total,1);
    assert.equal((await invoke(history,{from_id:1,to_id:2,actor_id:1})).total,0);
    const ownTransfers=await invoke(transfers,{from_id:1}, {},2);
    assert.equal(ownTransfers.total,1,'own-wallet-only account cannot see other recipients through sender filters');
  } finally { pool.query = originalQuery; pool.connect = originalConnect; await pg.close(); }
});
