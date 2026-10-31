import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp } from '../src/migrations/203_unified_cash_wallet.js';
import { up as imprestGuardUp } from '../src/migrations/195_imprest_cash_funding_guard.js';
import { up as fundingUp } from '../src/migrations/207_credit_wallet_imprest_debits.js';
import { up as scopeUp } from '../src/migrations/208_cash_wallet_site_scope.js';
import { up as balanceUp } from '../src/migrations/210_wallet_balance_guards.js';
import { up as custodyUp, VERSION } from '../src/migrations/217_admin_cash_custody_guard.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { createVaultTransfer, resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { adminWalletCashStates } from '../src/services/adminWalletCash.service.js';
import { ensureWalletStartup, walletStartupMigrations } from '../src/services/walletStartup.service.js';
import { up as walletImprestUp } from '../src/migrations/232_wallet_imprest_transfers.js';
import { createWalletImprestTransfer,resolveWalletImprestTransfer } from '../src/services/walletImprestTransfer.service.js';

test('Admin native cash expenses and Imprest enforce current cash custody', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => {
    const result = args?.length ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const scalar = async (sql, args) => Number(Object.values((await query(sql, args)).rows[0])[0]);
  const available = site => scalar('SELECT imprest_available_site_cash($1)', [site]);
  const financial = site => scalar('SELECT imprest_financial_site_cash($1)', [site]);
  const expense = (id, amount, status = 'pending', site = 10, user = 2) => query(
    "INSERT INTO expenses(id,site_id,created_by,debit,status,payment_mode) VALUES($1,$2,$3,$4,$5,'CASH')", [id,site,user,amount,status]);
  const receipt = (site, amount, user = null) => query(
    "INSERT INTO cash_flow_entries(site_id,created_by,credit,cash_type,status) VALUES($1,$2,$3,'CASH','approved')", [site,user,amount]);
  const align = (site, amount) => query("SELECT loyalty_vault_apply_delta('user:2',1,$1,'adjustment','Opening cash','manual_wallet_site_cash_alignment',NULL,NULL,$2,2)", [amount,site]);
  const handover = async (site, from, to, amount) => {
    const request = await createVaultTransfer({ id: from }, { site_id: site, amount: String(amount), recipient_id: to, idempotency_key: randomUUID() }, db);
    await resolveVaultTransfer({ id: to }, request.transfer.id, 'accept', { site_id: site }, db);
  };
  const noFunds = error => error.constraint === 'imprest_site_cash_funding';
  const snapshot = async () => {
    const result = {};
    for (const table of ['cash_flow_entries','expenses','farmer_payments','imprest_ledger','imprest_site_debit_reservations','loyalty_vault_accounts','loyalty_vault_entries']) {
      result[table] = (await query(`SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows;
    }
    return result;
  };
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Ravi','sub_admin',1,true),(2,'Kuldeep','admin',1,true),(3,'Sunny','sub_admin',1,true),(4,'Retired','sub_admin',1,false);
      CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
      INSERT INTO sites VALUES(10,'Custody boundary',1),(11,'Unaligned legacy site',1),(12,'Recorded custody boundary',1),(14,'DG Associates sequence',1),(20,'Other organization',2);
      CREATE TABLE user_sites(user_id integer,site_id integer); INSERT INTO user_sites VALUES(1,10),(1,12),(1,14),(3,14);
      CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text);
      CREATE TABLE farmers(id integer PRIMARY KEY,site_id integer); CREATE TABLE firms(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE plots(id integer PRIMARY KEY,site_id integer); CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer);
      CREATE TABLE cash_flow_months(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,site_id integer,created_by integer,credit numeric DEFAULT 0,debit numeric DEFAULT 0,
        cash_type text,status text,cheque_status text,particular text,source_module text,source_id integer,
        date date DEFAULT CURRENT_DATE,created_at timestamptz DEFAULT now(),voucher_url text,entry_transfer_id uuid,
        is_imprest_internal boolean,is_firm_transaction boolean,to_firm_id integer,UNIQUE(source_module,source_id));
      CREATE TABLE imprest_ledger(id serial PRIMARY KEY,user_id integer,site_id integer,type text,reference_id integer,
        source_module text,amount numeric,balance_after numeric,remarks text,created_by integer,proof_key text,created_at timestamptz DEFAULT now());
      CREATE UNIQUE INDEX ON imprest_ledger(user_id,site_id,source_module,reference_id,type) WHERE source_module IS NOT NULL;
      CREATE TABLE imprest_debit_reservations(source_module text,reference_id integer,user_id integer,site_id integer,
        amount numeric,remarks text,proof_key text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(source_module,reference_id));
      CREATE TABLE imprest_allocations(id integer PRIMARY KEY,site_id integer,admin_id integer DEFAULT 2,sub_admin_id integer DEFAULT 1,status text,
        from_own_float boolean DEFAULT false,amount numeric,created_at timestamptz DEFAULT now());
      CREATE TABLE imprest_transfers(id integer PRIMARY KEY,site_id integer,from_user_id integer,to_user_id integer,amount numeric);
      CREATE TABLE imprest_expense_requests(id integer PRIMARY KEY,site_id integer,assigned_admin_id integer,amount numeric,request_type text,status text);
      ${postingPolicySql}`);
    for (const table of [...LOYALTY_VAULT_SOURCE_TABLES].filter(table => table !== 'cash_flow_entries')) {
      await query(`CREATE TABLE ${table}(id integer PRIMARY KEY,site_id integer,created_by integer,status text DEFAULT 'pending',
        payment_mode text DEFAULT 'CASH',payment_type text,cheque_status text,entry_type text,created_at timestamptz DEFAULT now(),
        debit numeric DEFAULT 0,credit numeric DEFAULT 0,amount numeric,farmer_id integer,firm_id integer,plot_id integer,installment_id integer,cash_amount numeric,
        cash_flow_entry_id integer,expense_id integer,farmer_payment_id integer,commission_id integer,firm_transaction_id integer,
        plot_payment_id integer,vendor_payment_id integer,imprest_allocation_id integer,entry_transfer_id uuid,money_transfer_id uuid,
        is_firm_to_firm_transfer boolean,transfer_group_id uuid,is_financial_projection boolean,source_vendor_payment_id integer,is_imprest_internal boolean)`);
    }
    await query(`CREATE VIEW ledger_entries AS SELECT id::text AS id,source_module AS source_key,source_id,site_id,date AS entry_date,'cash'::text AS bucket,
      CASE WHEN financial_transaction_posts(CASE WHEN debit<0 THEN 'credit' ELSE 'debit' END,status,cash_type,cheque_status) THEN debit ELSE 0 END AS debit,
      CASE WHEN financial_transaction_posts(CASE WHEN credit<0 THEN 'debit' ELSE 'credit' END,status,cash_type,cheque_status) THEN credit ELSE 0 END AS credit
      FROM cash_flow_entries WHERE UPPER(cash_type)='CASH'`);
    const universal = await readFile(new URL('../src/migrations/125_universal_imprest_enforcement.js', import.meta.url), 'utf8');
    for (const name of ['refresh_imprest_balance_snapshots','imprest_debit_is_active','reconcile_imprest_debit','reconcile_direct_cashflow_imprest','sync_universal_imprest_from_source']) {
      const start = universal.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      const end = universal.indexOf('\n    `);', start);
      assert.ok(start >= 0 && end > start);
      await query(universal.slice(start, end));
    }
    await query(`CREATE OR REPLACE FUNCTION test_expense_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN DELETE FROM cash_flow_entries WHERE source_module='expenses' AND source_id=OLD.id; RETURN OLD; END IF;
      INSERT INTO cash_flow_entries(site_id,created_by,credit,debit,cash_type,status,source_module,source_id)
        VALUES(NEW.site_id,NEW.created_by,NEW.credit,NEW.debit,NEW.payment_mode,NEW.status,'expenses',NEW.id)
        ON CONFLICT(source_module,source_id) DO UPDATE SET site_id=EXCLUDED.site_id,created_by=EXCLUDED.created_by,
          credit=EXCLUDED.credit,debit=EXCLUDED.debit,cash_type=EXCLUDED.cash_type,status=EXCLUDED.status;
      RETURN NEW; END $$;
      CREATE TRIGGER trg_expense_projection AFTER INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION test_expense_projection();
      CREATE TRIGGER trg_zz_universal_imprest_expenses AFTER INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source();
      CREATE TRIGGER trg_zz_universal_imprest_cash_flow_entries AFTER INSERT OR UPDATE OR DELETE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source();
      CREATE OR REPLACE FUNCTION test_farmer_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='DELETE' THEN DELETE FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=OLD.id; RETURN OLD; END IF;
        INSERT INTO cash_flow_entries(site_id,created_by,debit,cash_type,status,source_module,source_id)
          VALUES(NEW.site_id,NEW.created_by,NEW.amount,NEW.payment_mode,NEW.status,'farmer_payments',NEW.id)
          ON CONFLICT(source_module,source_id) DO UPDATE SET debit=EXCLUDED.debit,status=EXCLUDED.status;
        RETURN NEW; END $$;
      CREATE TRIGGER trg_farmer_projection AFTER INSERT OR UPDATE OR DELETE ON farmer_payments FOR EACH ROW EXECUTE FUNCTION test_farmer_projection();`);
    await walletUp(db); await vaultUp(db); await unifiedUp(db); await imprestGuardUp(db); await fundingUp(db); await scopeUp(db); await balanceUp(db);
    await receipt(10,100); await align(10,100);
    await receipt(11,100,1);
    await receipt(12,1000); await align(12,100);
    const before = await snapshot();
    await custodyUp(db); await custodyUp(db);
    assert.deepEqual(await snapshot(),before,'migration and repeated installation change definitions only');

    await t.test('cash held by staff cannot fund native Admin cash expenses or another Imprest distribution', async () => {
      await handover(10,2,1,100);
      assert.equal(await financial(10),100);
      assert.equal(await available(10),0);
      await assert.rejects(expense(1,0.01),noFunds);
      assert.equal(await scalar('SELECT count(*) FROM expenses WHERE id=1'),0);
      assert.equal(await scalar("SELECT count(*) FROM cash_flow_entries WHERE source_module='expenses' AND source_id=1"),0);
      await assert.rejects(query("INSERT INTO imprest_allocations(id,site_id,status,amount) VALUES(1,10,'PENDING_RECEIPT',100)"),noFunds);
      await assert.rejects(query("INSERT INTO imprest_transfers(id,site_id,from_user_id,to_user_id,amount) VALUES(1,10,2,1,1)"),noFunds);
      await assert.rejects(query("INSERT INTO imprest_ledger(user_id,site_id,type,created_by,amount,balance_after) VALUES(1,10,'ADJUSTMENT',2,1,1)"),noFunds);
      assert.equal(await scalar('SELECT imprest_available_site_cash(10,1)'),0,'excluding a pending allocation cannot make staff custody available');
      await handover(10,1,2,100);
      assert.equal(await available(10),100);
    });

    await t.test('native pending and posted expense edits reserve exactly once and release on rejection or deletion', async () => {
      await assert.rejects(expense(2,100.01),noFunds);
      await expense(2,100);
      assert.equal(await available(10),0);
      await assert.rejects(expense(3,0.01),noFunds);
      await query("UPDATE expenses SET status='pending' WHERE id=2");
      await query("UPDATE expenses SET status='approved' WHERE id=2");
      await query("UPDATE expenses SET status='approved' WHERE id=2");
      assert.equal(await available(10),0);
      await assert.rejects(query('UPDATE expenses SET debit=100.01 WHERE id=2'),noFunds);
      await query("UPDATE expenses SET debit=60,status='pending' WHERE id=2");
      assert.equal(await available(10),40);
      await query("UPDATE expenses SET status='rejected' WHERE id=2");
      assert.equal(await available(10),100);
      await query("UPDATE expenses SET status='approved' WHERE id=2");
      assert.equal(await available(10),40);
      await query('DELETE FROM expenses WHERE id=2');
      assert.equal(await available(10),100);
      assert.equal(await scalar("SELECT sum(amount) FROM loyalty_vault_entries WHERE holder_key='user:2' AND site_id=10"),100,'expenses preserve immutable receipt and handover custody');
    });

    await t.test('own pending or posted amount is added back before the recorded Wallet cap', async () => {
      assert.equal(await financial(12),1000);
      assert.equal(await available(12),100);
      await expense(20,100,'pending',12);
      // This legacy shape has more financial cash than tracked custody. Keep
      // its existing conservative raw cap; adding this source's own amount
      // after applying that cap would incorrectly permit an increase to 101.
      assert.equal(await available(12),100,'raw recorded custody remains the tighter limit than spare financial cash');
      await assert.rejects(query('UPDATE expenses SET debit=101 WHERE id=20'),noFunds);
      await query("UPDATE expenses SET status='approved' WHERE id=20");
      await assert.rejects(query('UPDATE expenses SET debit=101 WHERE id=20'),noFunds);
      await query("UPDATE expenses SET status='approved' WHERE id=20");
      await query('DELETE FROM expenses WHERE id=20');
      assert.equal(await available(12),100);
    });

    await t.test('unaligned sites retain existing financial cash funding rules', async () => {
      assert.equal(await available(11),100);
      await expense(30,100,'approved',11);
      assert.equal(await available(11),0);
      await assert.rejects(expense(31,0.01,'pending',11),noFunds);
      await query('DELETE FROM expenses WHERE id=30');
      assert.equal(await available(11),100);
    });

    await t.test('the original 20 lakh receipt, accepted handover, Imprest and farmer payout never restore spent Admin cash', async () => {
      await receipt(14,7661125); await align(14,7661125);
      await query("INSERT INTO imprest_ledger(user_id,site_id,type,amount,balance_after) VALUES(3,14,'ALLOCATION',47105,47105)");
      const base=7614020;
      const walletCash=async()=>Number((await adminWalletCashStates(1,14,db)).get('user:2').available_balance);
      assert.equal(await available(14),base);
      await query("INSERT INTO farmer_payments(id,site_id,created_by,amount,payment_mode,status) VALUES(1202,14,1,-2000000,'CASH','approved')");
      assert.equal(await available(14),base,'staff collects incoming cash');
      await handover(14,1,2,2000000);
      assert.equal(await available(14),base+2000000);
      await query("INSERT INTO imprest_allocations(id,site_id,status,amount) VALUES(62,14,'PENDING_RECEIPT',2000000)");
      assert.equal(await available(14),base);
      assert.equal(await scalar('SELECT imprest_available_site_cash(14,62)'),base+2000000,'acceptance can use its own reservation');
      await query("BEGIN; UPDATE imprest_allocations SET status='RECEIVED' WHERE id=62; INSERT INTO imprest_ledger(user_id,site_id,type,reference_id,amount,balance_after) VALUES(1,14,'ALLOCATION',62,2000000,2000000); COMMIT;");
      assert.equal(await available(14),base);
      await query("INSERT INTO farmer_payments(id,site_id,created_by,amount,payment_mode,status) VALUES(1204,14,1,2000000,'CASH','approved')");
      assert.equal(await scalar('SELECT sum(amount) FROM imprest_ledger WHERE user_id=1 AND site_id=14'),0);
      assert.equal(await available(14),base);
      assert.equal(await walletCash(),base);
      await assert.rejects(expense(40,base+0.01,'pending',14),noFunds);
      await expense(40,base,'pending',14);
      assert.equal(await available(14),0);
      await query('DELETE FROM expenses WHERE id=40');
      assert.equal(await available(14),base);
    });

    await t.test('startup repairs a repeated older funding migration without changing financial rows', async () => {
      for (const [version] of walletStartupMigrations) await query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[version]);
      await handover(10,2,1,100);
      await fundingUp(db);
      assert.equal(await available(10),100,'older repeatable migration reinstalls its financial-only function');
      const originals=await snapshot();
      const result=await ensureWalletStartup(db);
      assert.equal(result.current,true);
      assert.deepEqual(result.applied,[]);
      assert.ok(result.repaired.includes('imprest_available_site_cash'));
      assert.ok(result.repaired.includes('reconcile_site_cash_debit'));
      assert.equal(await available(10),0);
      assert.deepEqual(await snapshot(),originals,'startup recovery writes function definitions only');
      assert.deepEqual(await ensureWalletStartup(db),{applied:[],current:true,repaired:[]});
      assert.equal(await scalar('SELECT count(*) FROM app_schema_migrations WHERE version=$1',[VERSION]),1);

      const start=universal.indexOf('CREATE OR REPLACE FUNCTION reconcile_imprest_debit(');
      await query(universal.slice(start,universal.indexOf('\n    `);',start)));
      const beforeRepair=await snapshot();
      const recovered=await ensureWalletStartup(db);
      assert.ok(recovered.repaired.includes('reconcile_imprest_debit'),'restore the site cash caller after interrupted migration 125');
      await assert.rejects(expense(50,0.01),noFunds);
      assert.deepEqual(await snapshot(),beforeRepair);
    });
    await t.test('wallet-funded imprest keeps aligned Admin custody unchanged for staff funding and debits own funding once',async()=>{
      await query('CREATE TABLE user_permissions(user_id integer,module text,can_read boolean,can_view_all boolean)');
      await walletImprestUp(db);
      const walletCash=async()=>Number((await adminWalletCashStates(1,14,db)).get('user:2').available_balance);
      const before=await walletCash();
      await receipt(14,10000.15,1);
      assert.equal(await walletCash(),before,'staff cash collection remains outside Admin custody');
      const request=await createWalletImprestTransfer({id:3},{site_id:14,from_user_id:1,to_user_id:3,amount:'10000.15',note:'Staff wallet allocation',idempotency_key:randomUUID()},db);
      await resolveWalletImprestTransfer({id:1},request.transfer.id,'accept',{site_id:14},db);
      assert.equal(await walletCash(),before,'one acceptance never changes either cash balance');
      await resolveWalletImprestTransfer({id:3},request.transfer.id,'accept',{site_id:14},db);
      assert.equal(await walletCash(),before,'staff wallet debit offsets the same rise in staff float');
      const own=await createWalletImprestTransfer({id:1},{site_id:14,from_user_id:2,to_user_id:3,amount:'20000.25',note:'Admin wallet allocation',idempotency_key:randomUUID()},db);
      await resolveWalletImprestTransfer({id:3},own.transfer.id,'accept',{site_id:14},db);
      await resolveWalletImprestTransfer({id:2},own.transfer.id,'accept',{site_id:14},db);
      assert.equal(await walletCash(),Math.round((before-20000.25)*100)/100,'Admin source is reduced once, including when Admin accepts last');
      assert.equal(await scalar('SELECT count(*) FROM imprest_ledger WHERE wallet_imprest_transfer_id=$1',[own.transfer.id]),1);
    });
  } finally { await pg.close(); }
});
