import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp } from '../src/migrations/203_unified_cash_wallet.js';
import { up as siteUp } from '../src/migrations/208_cash_wallet_site_scope.js';
import { up } from '../src/migrations/209_cash_wallet_receipt_details.js';
import { up as collectorUp } from '../src/migrations/211_locked_cash_collector.js';
import { applyApprovedEditRequest } from '../src/controllers/editRequest.controller.js';
import { up as balanceUp } from '../src/migrations/210_wallet_balance_guards.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { createVaultTransfer, resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';

test('cash receipts in every native module belong to the collector and can be handed over', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE), pg = new PGlite();
  const query = async (sql, args) => {
    const result = args?.length ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  let serial = 100;
  const insert = async (table, data) => {
    const columns = Object.keys(data);
    await query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(data));
    return data.id;
  };
  const cash = async data => insert('cash_flow_entries', {
    id: serial++, site_id: 10, created_by: 1, credit: 0, debit: 0, cash_type: 'CASH',
    status: 'pending', particular: 'Generated module label', ...data,
  });
  // These are the actual module mirror signs: receipts in credit columns,
  // recoveries of paid money in negative debit columns. The wallet's deferred
  // database triggers inspect both the native source and its financial mirror.
  const receipt = async (table, source = {}, mirror = {}) => {
    if (table === 'cash_flow_entries') return cash({ credit: 100, ...mirror });
    const id = serial++;
    await insert(table, { id, site_id: 10, created_by: 1, payment_mode: 'CASH', status: 'pending', ...source });
    return cash({ source_module: table, source_id: id, credit: 100, ...mirror });
  };
  const balance = async id => Number((await query("SELECT COALESCE(sum(amount),0)::text AS amount FROM loyalty_vault_entries WHERE holder_key='user:'||$1::text AND site_id=10", [id])).rows[0].amount);
  const movement = async id => (await query('SELECT * FROM loyalty_vault_entries WHERE cash_flow_entry_id=$1 ORDER BY id DESC LIMIT 1', [id])).rows[0];
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Ravi','sub_admin',1,true),(2,'Kuldeep','admin',1,true),(3,'Another collector','super_admin',1,true),(4,'Inactive maker','sub_admin',1,false);
      CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);INSERT INTO sites VALUES(10,'Project',1),(11,'Other project',1);
      CREATE TABLE user_sites(user_id integer,site_id integer);INSERT INTO user_sites VALUES(1,10),(3,10);
      CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text);INSERT INTO members VALUES(1,10,'Known client','9999999999');
      CREATE TABLE cash_flow_entries(id integer PRIMARY KEY,site_id integer,created_by integer,credit numeric DEFAULT 0,debit numeric DEFAULT 0,
        cash_type text,status text,cheque_status text,particular text,remarks text,source_module text,source_id integer,date date DEFAULT CURRENT_DATE,
        created_at timestamptz DEFAULT now(),entry_transfer_id uuid,is_imprest_internal boolean,is_firm_transaction boolean,to_firm_id integer);
      CREATE TABLE cash_flow_months(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE farmers(id integer PRIMARY KEY,site_id integer);CREATE TABLE firms(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE plots(id integer PRIMARY KEY,site_id integer);CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer);
      ${postingPolicySql}`);
    for (const table of [...LOYALTY_VAULT_SOURCE_TABLES].filter(table => table !== 'cash_flow_entries')) await query(`CREATE TABLE ${table}(
      id integer PRIMARY KEY,site_id integer,created_by integer,status text,payment_mode text,payment_type text,cheque_status text,
      created_at timestamptz DEFAULT now(),amount numeric,cash_amount numeric,direction text,
      particular text,description text,narration text,remarks text,remark text,note text,category text,sub_category text,
      party_name text,payment_from text,reference_no text,bank_reference text,transaction_id text,cheque_no text,
      farmer_id integer,firm_id integer,plot_id integer,installment_id integer,entry_type text,
      cash_flow_entry_id integer,expense_id integer,farmer_payment_id integer,commission_id integer,firm_transaction_id integer,
      plot_payment_id integer,vendor_payment_id integer,imprest_allocation_id integer,source_vendor_payment_id integer,
      entry_transfer_id uuid,money_transfer_id uuid,is_firm_to_firm_transfer boolean,transfer_group_id uuid,
      is_financial_projection boolean,is_imprest_internal boolean)`);
    await walletUp(db); await vaultUp(db); await unifiedUp(db); await siteUp(db); await up(db); await balanceUp(db);
    // Pre-existing assignments are deliberately retained when 211 is installed.
    await insert('expenses', {id:1,site_id:10,created_by:1,payment_mode:'CASH',status:'approved',remark:'Historical member custody',loyalty_vault_holder_type:'member',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:2});
    await collectorUp(db);

    await t.test('a 20,000 expense followed by 15,000 cash received creates transferable collector cash', async () => {
      const paid = await receipt('expenses', { amount: 20000, remark: 'Advertising paid', category: 'ADVERTISING', status: 'approved' }, { debit: 20000, credit: 0, status: 'approved' });
      assert.equal(await balance(1), 0, 'business spending uses Imprest rather than subtracting wallet receipts');
      assert.equal(await movement(paid), undefined);
      const received = await receipt('expenses', { amount: 15000, remark: 'Advertising refund received', category: 'ADVERTISING' }, { credit: 15000 });
      assert.equal(await balance(1), 15000, 'pending physical cash is already held by its collector');
      const entry = await movement(received);
      assert.equal(entry.description, 'Advertising refund received');
      assert.equal(entry.details.source_description, 'Advertising refund received');
      assert.equal(entry.details.remarks, 'Advertising refund received');
      assert.equal(entry.details.category, 'ADVERTISING');
      const request = { site_id: 10, to_holder_id: 2, amount: '15000', idempotency_key: randomUUID(), note: 'Cash refund handover' };
      const transfer = await createVaultTransfer({ id: 1 }, request, db);
      assert.equal(await balance(1), 15000);
      await resolveVaultTransfer({ id: 2 }, transfer.transfer.id, 'accept', { site_id: 10 }, db);
      assert.equal(await balance(1), 0); assert.equal(await balance(2), 15000);
      assert.equal((await resolveVaultTransfer({ id: 2 }, transfer.transfer.id, 'accept', { site_id: 10 }, db)).replayed, true);
      await assert.rejects(createVaultTransfer({ id: 1 }, { ...request, amount: '0.01', idempotency_key: randomUUID() }, db), error => error.statusCode === 409);
    });

    await t.test('every receive-capable module uses the original collector, including signed recoveries and split cash', async () => {
      const examples = [
        ['cash_flow_entries', {}, { credit: 100 }],
        ['day_book', { particular: 'Site cash received', entry_type: 'GENERAL' }],
        ['expenses', { remark: 'Expense cash recovered' }],
        ['firm_transactions', { description: 'Firm cash returned' }],
        ['plot_payments', { amount: 100, payment_mode: null, payment_type: 'CASH', narration: 'Booking cash received' }],
        ['plot_installment_payments', { amount: 100, remarks: 'Installment cash received' }],
        ['farmer_payments', { amount: -100, remarks: 'Farmer advance recovered' }, { credit: 0, debit: -100 }],
        ['plot_commission_payments', { amount: -100, remarks: 'Agent commission recovered' }, { credit: 0, debit: -100 }],
        ['vendor_payments', { amount: -100, note: 'Vendor cash refund' }, { credit: 0, debit: -100 }],
        ['vendor_inventory_payments', { amount: -100, note: 'Inventory cash refund' }, { credit: 0, debit: -100 }],
        ['land_deal_payments', { amount: 100, remarks: 'Land buyer cash received' }],
        ['misc_income_entries', { amount: 100, direction: 'credit', remarks: 'Maintenance cash received' }],
        ['farmer_payments', { amount: -1000, payment_mode: 'SPLIT', cash_amount: -100, remarks: 'Cash leg of split recovery' }, { credit: 0, debit: -1000, cash_type: 'bank' }],
      ];
      let expected = 0;
      for (const [table, source, mirror] of examples) {
        const id = await receipt(table, source, mirror);
        expected += 100;
        assert.equal(await balance(1), expected, `${table} credits only its physical incoming cash`);
        assert.equal((await movement(id)).holder_key, 'user:1');
        await query("UPDATE cash_flow_entries SET status='approved' WHERE id=$1", [id]);
        assert.equal(await balance(1), expected, `${table} approval never duplicates the receipt`);
        assert.equal((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries WHERE cash_flow_entry_id=$1', [id])).rows[0].n, 1);
      }
      await assert.rejects(receipt('expenses', { remark: 'Forged colleague collector', loyalty_vault_holder_type: 'user', loyalty_vault_holder_id: 3, loyalty_vault_assigned_by: 1 }),error=>error.constraint==='cash_wallet_collector_locked');
      assert.equal(await balance(3), 0);
      assert.equal(await balance(1), expected);
    });

    await t.test('every native source rejects alternate collectors, including admins, and preserves maker on edit', async () => {
      for(const table of LOYALTY_VAULT_SOURCE_TABLES){
        for(const actor of [1,2,3]){
          const base={id:serial++,site_id:10,created_by:actor,...(table==='cash_flow_entries'?{cash_type:'CASH',credit:100}:{payment_mode:'CASH',status:'pending'})};
          for(const forged of [{loyalty_vault_holder_type:'user',loyalty_vault_holder_id:actor===1?2:1},{loyalty_vault_holder_type:'member',loyalty_vault_holder_id:1}]){
            await assert.rejects(insert(table,{...base,...forged,loyalty_vault_assigned_by:actor}),error=>error.constraint==='cash_wallet_collector_locked',table);
          }
          await insert(table,base);
          const source=(await query(`SELECT created_by,loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by FROM ${table} WHERE id=$1`,[base.id])).rows[0];
          assert.deepEqual(source,{created_by:actor,loyalty_vault_holder_type:null,loyalty_vault_holder_id:null,loyalty_vault_assigned_by:null},table);
          const explicitId=serial++;
          await insert(table,{...base,id:explicitId,loyalty_vault_holder_type:'user',loyalty_vault_holder_id:actor,loyalty_vault_assigned_by:999});
          for(const patch of ["loyalty_vault_holder_id="+(actor===1?2:1),"loyalty_vault_holder_type=NULL,loyalty_vault_holder_id=NULL","loyalty_vault_assigned_by="+(actor===1?2:1),"created_by="+(actor===1?2:1)]){
            await assert.rejects(query(`UPDATE ${table} SET ${patch} WHERE id=$1`,[explicitId]),error=>error.constraint==='cash_wallet_collector_locked',table);
          }
          await query(`UPDATE ${table} SET status='approved' WHERE id=$1`,[base.id]);
        }
      }
    });

    await t.test('omitted collector preserves historical import cutoff and inactive maker business spending',async()=>{
      const before=await balance(1),old=serial++;
      await insert('cash_flow_entries',{id:old,site_id:10,created_by:1,credit:700,cash_type:'CASH',status:'approved',created_at:'2020-01-01'});
      assert.equal(await movement(old),undefined);assert.equal(await balance(1),before);
      await receipt('expenses',{created_by:4,amount:20000,remark:'Original inactive maker outgoing expense',status:'approved'},{credit:0,debit:20000,status:'approved'});
      assert.equal(await balance(4),0);assert.equal(await balance(1),before);
    });

    await t.test('approval edits retain historical collector and original assignment actor, but reject proposed reassignment',async()=>{
      const original=(await query('SELECT * FROM expenses WHERE id=1')).rows[0];
      await applyApprovedEditRequest({module:'daybook_expense',record_id:1},{remark:'Reviewed historical receipt'}, {id:2,role:'admin'},db);
      const reviewed=(await query('SELECT * FROM expenses WHERE id=1')).rows[0];
      assert.equal(reviewed.remark,'Reviewed historical receipt');
      assert.equal(reviewed.created_by,original.created_by);assert.equal(reviewed.loyalty_vault_holder_type,'member');
      assert.equal(reviewed.loyalty_vault_holder_id,original.loyalty_vault_holder_id);assert.equal(reviewed.loyalty_vault_assigned_by,original.loyalty_vault_assigned_by);
      await assert.rejects(applyApprovedEditRequest({module:'daybook_expense',record_id:1},{remark:'Reassigned draft',loyalty_vault_holder_type:'user',loyalty_vault_holder_id:2},{id:2,role:'admin'},db),error=>error.constraint==='cash_wallet_collector_locked');
      assert.deepEqual((await query('SELECT * FROM expenses WHERE id=1')).rows[0],reviewed);
    });

    await t.test('only exact original recycle-bin records can retain an archived collector on insertion',async()=>{
      await query('CREATE TABLE recycle_bin_entries(source_schema text,source_table text,row_data jsonb,restored_at timestamptz)');
      const archived={id:serial++,site_id:10,created_by:1,payment_mode:'CASH',status:'approved',remark:'Archived cash collector',loyalty_vault_holder_type:'member',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:2};
      await query("INSERT INTO recycle_bin_entries VALUES(current_schema(),'expenses',$1::jsonb,NULL)",[JSON.stringify(archived)]);
      await insert('expenses',archived);
      assert.equal((await query('SELECT loyalty_vault_holder_type FROM expenses WHERE id=$1',[archived.id])).rows[0].loyalty_vault_holder_type,'member');
      await query('DELETE FROM expenses WHERE id=$1',[archived.id]);
      await assert.rejects(insert('expenses',{...archived,remark:'Altered restore attempt'}),error=>error.constraint==='cash_wallet_collector_locked');
      await query('UPDATE recycle_bin_entries SET restored_at=now()');
      await assert.rejects(insert('expenses',archived),error=>error.constraint==='cash_wallet_collector_locked');
    });

    await t.test('noncash, outgoing-only profit payments, registry allocations, internal projections and transfers never mint receipts', async () => {
      const before = await balance(1);
      await receipt('expenses', { payment_mode: 'BANK' });
      await receipt('partner_profit_payments', { amount: 100, status: 'approved' }, { credit: 0, debit: 100, status: 'approved' });
      await cash({ source_module: 'plot_registry_payments', source_id: 9999, credit: 100 });
      await receipt('day_book', { entry_type: 'IMPREST', is_financial_projection: true });
      await receipt('day_book', { expense_id: 123 });
      await receipt('vendor_inventory_payments', { source_vendor_payment_id: 123 });
      await receipt('firm_transactions', { is_firm_to_firm_transfer: true });
      await receipt('plot_payments', { entry_transfer_id: randomUUID() });
      await receipt('expenses', { status: 'rejected' });
      assert.equal(await balance(1), before);
    });

    await t.test('receipt edits and deletions append precise deltas and retain the recorded source narration', async () => {
      const id = await receipt('expenses', { remark: 'Cash recovered for cement', category: 'MATERIALS' });
      const first = await movement(id), before = await balance(1);
      await query("UPDATE expenses SET remark='Corrected cement refund' WHERE id=(SELECT source_id FROM cash_flow_entries WHERE id=$1)", [id]);
      await query('UPDATE cash_flow_entries SET credit=150 WHERE id=$1', [id]);
      assert.equal(await balance(1), before + 50);
      assert.equal((await movement(id)).description, 'Corrected cement refund');
      await query('DELETE FROM cash_flow_entries WHERE id=$1', [id]);
      const removed = await movement(id);
      assert.equal(await balance(1), before - 100);
      assert.equal(removed.kind, 'reversal'); assert.equal(Number(removed.amount), -150);
      assert.equal(removed.description, 'Corrected cement refund');
      assert.equal(removed.details.source_description, 'Corrected cement refund');
      assert.equal(removed.details.source_deleted, true);
      assert.deepEqual((await query('SELECT * FROM loyalty_vault_entries WHERE id=$1', [first.id])).rows[0], first);
    });

    await t.test('reinstalling receipt capture preserves source records, balances and immutable history', async () => {
      const before = (await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows;
      const finances = (await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows;
      const accounts = (await query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows;
      await up(db); await up(db); await balanceUp(db); await collectorUp(db); await collectorUp(db);
      assert.deepEqual((await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows, before);
      assert.deepEqual((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows, finances);
      assert.deepEqual((await query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows, accounts);
    });
  } finally { await pg.close(); }
});
