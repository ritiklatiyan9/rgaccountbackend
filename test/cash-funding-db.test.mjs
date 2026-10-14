import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp } from '../src/migrations/203_unified_cash_wallet.js';
import { up } from '../src/migrations/207_credit_wallet_imprest_debits.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { vaultTransactionsCte, vaultPendingTransactionsCte } from '../src/services/loyaltyVaultTransactions.service.js';
import { createVaultTransfer, resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { getSiteBalanceDetail } from '../src/graphql/services/kpi.service.js';

test('business cash debits consume imprest and leave receipt/transfer wallets separate', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => {
    const result = args?.length ? await pg.query(sql, args) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  const scalar = async (sql, args) => Number(Object.values((await query(sql, args)).rows[0])[0]);
  const wallet = id => scalar('SELECT COALESCE((SELECT balance FROM loyalty_vault_accounts WHERE holder_key=$1),0)', [`user:${id}`]);
  const float = () => scalar('SELECT COALESCE(SUM(amount),0) FROM imprest_ledger WHERE user_id=1 AND site_id=10');
  const held = () => scalar('SELECT COALESCE(SUM(amount),0) FROM imprest_debit_reservations WHERE user_id=1 AND site_id=10');
  const siteCash = () => scalar('SELECT imprest_available_site_cash(10)');
  const expense = (id, user, debit, status = 'pending', mode = 'CASH', credit = 0) => query(
    'INSERT INTO expenses(id,site_id,created_by,debit,credit,status,payment_mode) VALUES($1,10,$2,$3,$4,$5,$6)', [id, user, debit, credit, status, mode]);
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Staff','sub_admin',1,true),(2,'Admin','admin',1,true),(3,'Other admin','admin',1,true);
      CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer); INSERT INTO sites VALUES(10,'Project',1),(11,'Empty project',1);
      CREATE TABLE user_sites(user_id integer,site_id integer); INSERT INTO user_sites VALUES(1,10);
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
      CREATE TABLE imprest_allocations(id integer PRIMARY KEY,site_id integer,status text,from_own_float boolean,amount numeric,created_at timestamptz DEFAULT now());
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
    const migration = await readFile(new URL('../src/migrations/125_universal_imprest_enforcement.js', import.meta.url), 'utf8');
    for (const name of ['refresh_imprest_balance_snapshots', 'imprest_debit_is_active', 'reconcile_imprest_debit', 'reconcile_direct_cashflow_imprest', 'sync_universal_imprest_from_source']) {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
      const end = migration.indexOf('\n    `);', start);
      assert.ok(start >= 0 && end > start, `${name} SQL must be present`);
      await query(migration.slice(start, end));
    }
    await query(`CREATE OR REPLACE FUNCTION test_expense_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN DELETE FROM cash_flow_entries WHERE source_module='expenses' AND source_id=OLD.id; RETURN OLD; END IF;
      INSERT INTO cash_flow_entries(site_id,created_by,credit,debit,cash_type,status,cheque_status,source_module,source_id)
        VALUES(NEW.site_id,NEW.created_by,NEW.credit,NEW.debit,NEW.payment_mode,NEW.status,NEW.cheque_status,'expenses',NEW.id)
        ON CONFLICT(source_module,source_id) DO UPDATE SET site_id=EXCLUDED.site_id,created_by=EXCLUDED.created_by,
          credit=EXCLUDED.credit,debit=EXCLUDED.debit,cash_type=EXCLUDED.cash_type,status=EXCLUDED.status,cheque_status=EXCLUDED.cheque_status;
      RETURN NEW; END $$;
      CREATE TRIGGER trg_expense_projection AFTER INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION test_expense_projection();
      CREATE TRIGGER trg_zz_universal_imprest_expenses AFTER INSERT OR UPDATE OR DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source();
      CREATE TRIGGER trg_zz_universal_imprest_cash_flow_entries AFTER INSERT OR UPDATE OR DELETE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION sync_universal_imprest_from_source();`);
    await query(`CREATE OR REPLACE FUNCTION test_other_payment_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN DELETE FROM cash_flow_entries WHERE source_module=TG_TABLE_NAME AND source_id=OLD.id; RETURN OLD; END IF;
      INSERT INTO cash_flow_entries(site_id,created_by,debit,cash_type,status,cheque_status,source_module,source_id)
        VALUES(NEW.site_id,NEW.created_by,CASE WHEN NEW.payment_mode='SPLIT' THEN NEW.cash_amount ELSE NEW.amount END,
          CASE WHEN NEW.payment_mode='SPLIT' THEN 'CASH' ELSE NEW.payment_mode END,NEW.status,NEW.cheque_status,TG_TABLE_NAME,NEW.id)
        ON CONFLICT(source_module,source_id) DO UPDATE SET site_id=EXCLUDED.site_id,created_by=EXCLUDED.created_by,
          debit=EXCLUDED.debit,cash_type=EXCLUDED.cash_type,status=EXCLUDED.status,cheque_status=EXCLUDED.cheque_status;
      RETURN NEW; END $$;
      CREATE TRIGGER trg_other_payment_projection AFTER INSERT OR UPDATE OR DELETE ON farmer_payments FOR EACH ROW EXECUTE FUNCTION test_other_payment_projection();
      CREATE TRIGGER trg_other_payment_projection AFTER INSERT OR UPDATE OR DELETE ON partner_profit_payments FOR EACH ROW EXECUTE FUNCTION test_other_payment_projection();`);
    await walletUp(db); await vaultUp(db); await unifiedUp(db);
    await query("INSERT INTO cash_flow_entries(site_id,created_by,credit,cash_type,status) VALUES(10,1,500,'CASH','pending')");
    // Model a deduction already captured by the previous wallet policy.
    await expense(90, 2, 20, 'approved');
    const legacy = (await query("SELECT id FROM cash_flow_entries WHERE source_module='expenses' AND source_id=90")).rows[0].id;
    await query("SELECT loyalty_vault_apply_delta('user:2',1,-20,'debit','Old expense deduction','expenses',90,$1,10)", [legacy]);
    await query("INSERT INTO loyalty_vault_sources(cash_flow_entry_id,holder_key,posted_amount,organization_id,source_table,source_id,site_id) VALUES($1,'user:2',-20,1,'expenses',90,10)", [legacy]);
    const originalHistory = JSON.stringify((await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows);
    await up(db); await up(db);
    assert.equal(await wallet(2), 0, 'prior erroneous wallet spend gets a compensating reversal once');
    assert.equal(JSON.stringify((await query('SELECT * FROM loyalty_vault_entries ORDER BY id LIMIT 2')).rows), originalHistory);
    assert.equal(await wallet(1), 500);

    await t.test('zero staff imprest rejects pending cash expenses despite a funded wallet', async () => {
      await assert.rejects(expense(1, 1, 10), error => error.constraint === 'imprest_sufficient_balance');
      assert.equal(await scalar('SELECT count(*) FROM expenses WHERE id=1'), 0);
      assert.equal(await scalar("SELECT count(*) FROM cash_flow_entries WHERE source_module='expenses' AND source_id=1"), 0);
      assert.equal(await wallet(1), 500);
    });
    await query("INSERT INTO imprest_ledger(user_id,site_id,type,amount,balance_after) VALUES(1,10,'ALLOCATION',100,100)");
    await t.test('pending/approval/edits/rejection/delete charge only the creator imprest once', async () => {
      await expense(2, 1, 100, 'waiting'); assert.equal(await held(), 100); assert.equal(await float(), 100);
      await assert.rejects(expense(3, 1, 1), error => error.constraint === 'imprest_sufficient_balance');
      await query("UPDATE expenses SET status='pending' WHERE id=2"); assert.equal(await held(), 100);
      await query("UPDATE expenses SET status='approved' WHERE id=2"); assert.equal(await float(), 0); assert.equal(await held(), 0);
      await query("UPDATE expenses SET status='approved' WHERE id=2"); assert.equal(await float(), 0);
      await query("UPDATE expenses SET debit=80,status='pending' WHERE id=2"); assert.equal(await float(), 100); assert.equal(await held(), 80);
      await query("UPDATE expenses SET status='returned' WHERE id=2"); assert.equal(await held(), 0);
      await query("UPDATE expenses SET status='approved' WHERE id=2"); assert.equal(await float(), 20);
      await query('DELETE FROM expenses WHERE id=2'); assert.equal(await float(), 100);
      assert.equal(await wallet(1), 500); assert.equal(await wallet(2), 0);
      await expense(4, 1, 1000, 'approved', 'BANK'); assert.equal(await float(), 100);
    });
    await t.test('admin cash reservations share site funding, allow exact edits, and never spend wallet', async () => {
      const available = await siteCash();
      await expense(5, 2, available); assert.equal(await siteCash(), 0);
      assert.equal((await getSiteBalanceDetail(10, '1900-01-01', '2999-01-01', db)).distributableBalance, 0);
      await assert.rejects(expense(6, 3, 1), error => error.constraint === 'imprest_site_cash_funding');
      await query("UPDATE expenses SET status='pending' WHERE id=5"); assert.equal(await siteCash(), 0);
      await query("UPDATE expenses SET status='approved' WHERE id=5"); assert.equal(await siteCash(), 0);
      await query("UPDATE expenses SET status='approved' WHERE id=5"); assert.equal(await siteCash(), 0);
      await query("UPDATE expenses SET debit=10,status='pending' WHERE id=5"); assert.equal(await siteCash(), available - 10);
      await query("UPDATE expenses SET status='rejected' WHERE id=5"); assert.equal(await siteCash(), available);
      await query('DELETE FROM expenses WHERE id=5'); assert.equal(await siteCash(), available);
      assert.equal(await wallet(1), 500); assert.equal(await wallet(2), 0);
      await assert.rejects(query("INSERT INTO expenses(id,site_id,created_by,debit,status,payment_mode) VALUES(8,11,2,1,'pending','CASH')"), error => error.constraint === 'imprest_site_cash_funding');
    });
    await t.test('refund signs debit imprest, while cash receipts and wallet transfers remain separate', async () => {
      await expense(7, 1, 0, 'pending', 'CASH', -30); assert.equal(await held(), 30);
      await query("UPDATE expenses SET status='approved' WHERE id=7"); assert.equal(await float(), 70); assert.equal(await wallet(1), 500);
      const transfer = await createVaultTransfer({ id: 1 }, { amount: '25', recipient_id: 2, idempotency_key: randomUUID() }, db);
      await resolveVaultTransfer({ id: 2 }, transfer.transfer.id, 'accept', {}, db);
      assert.equal(await wallet(1), 475); assert.equal(await wallet(2), 25); assert.equal(await float(), 70);
      assert.equal(await scalar(`${vaultTransactionsCte} SELECT count(*) FROM assigned_transactions WHERE debit>0 OR source_table='expenses' AND credit=0`), 0);
      assert.equal(await scalar(`${vaultPendingTransactionsCte} SELECT count(*) FROM assigned_transactions`), 0);
    });
    await t.test('farmer split payments use only physical cash and survive older migration reinstallation', async () => {
      await query("INSERT INTO farmer_payments(id,site_id,created_by,amount,cash_amount,payment_mode,status) VALUES(100,10,1,300,20,'SPLIT','pending')");
      assert.equal(await held(), 20); assert.equal(await float(), 70);
      await query("UPDATE farmer_payments SET status='approved' WHERE id=100"); assert.equal(await float(), 50);
      await query('UPDATE farmer_payments SET cash_amount=25 WHERE id=100'); assert.equal(await float(), 45);
      await assert.rejects(query("INSERT INTO farmer_payments(id,site_id,created_by,amount,cash_amount,payment_mode,status) VALUES(101,10,1,300,46,'SPLIT','pending')"), error => error.constraint === 'imprest_sufficient_balance');
      assert.equal(await wallet(1), 475);
      const start = migration.indexOf('CREATE OR REPLACE FUNCTION reconcile_imprest_debit(');
      await query(migration.slice(start, migration.indexOf('\n    `);', start)));
      await query("SELECT reconcile_imprest_debit('farmer_payment',100,1,10,0,false,false,'OLDER MIGRATION NON-CASH RELEASE',NULL)");
      assert.equal(await float(), 70);
      await up(db); assert.equal(await float(), 45); assert.equal(await wallet(1), 475);
      await query("UPDATE farmer_payments SET payment_mode='BANK' WHERE id=100"); assert.equal(await float(), 70);
      await query('DELETE FROM farmer_payments WHERE id=100'); assert.equal(await float(), 70);
    });
    await t.test('additional cash payments enforce the same Admin site funding and never debit wallet', async () => {
      const available = await siteCash();
      await query("INSERT INTO partner_profit_payments(id,site_id,created_by,amount,payment_mode,status) VALUES(110,10,2,$1,'CASH','pending')", [available]);
      assert.equal(await siteCash(), 0);
      await assert.rejects(query("INSERT INTO partner_profit_payments(id,site_id,created_by,amount,payment_mode,status) VALUES(111,10,2,1,'CASH','pending')"), error => error.constraint === 'imprest_site_cash_funding');
      await query("UPDATE partner_profit_payments SET status='approved' WHERE id=110"); assert.equal(await siteCash(), 0);
      await query('DELETE FROM partner_profit_payments WHERE id=110'); assert.equal(await siteCash(), available);
      assert.equal(await wallet(2), 25);
    });
  } finally { await pg.close(); }
});
