import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/163_paired_transaction_transfers.js';
import { getTransferOptions, previewTransfer, transferEntry } from '../src/controllers/transactionTransfer.controller.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const invoke = (handler, body) => new Promise((resolve, reject) => handler(
  { body, method: 'POST', user: { id: 1, role: 'admin' } },
  { status() { return this; }, json: resolve }, reject,
));
const owners = {
  expense: 'expenses', farmer_payment: 'farmer_payments', plot_payment: 'plot_payments',
  plot_commission: 'plot_commission_payments', vendor_payment: 'vendor_payments',
  vendor_inventory_payment: 'vendor_inventory_payments',
  misc_income: 'misc_income_entries', land_sale: 'land_deal_payments', daybook: 'day_book',
};
const functionsFrom = async (db, file, names) => {
  const source = await read(`src/migrations/${file}`);
  for (const name of names) {
    const match = source.match(new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?AS \\$\\$[\\s\\S]*?\\$\\$`));
    assert.ok(match, `${file} defines ${name}`);
    await db.exec(match[0]);
  }
};

test('real accounting CHECK constraints and native mirror functions accept balanced transfers', {
  skip: !process.env.PGLITE_MODULE,
}, async (t) => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const previous = { query: pool.query, connect: pool.connect };
  const query = async (sql, values) => {
    const result = values?.length ? await db.query(sql, values) : (await db.exec(sql)).at(-1);
    return { ...result, rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  pool.query = query;
  pool.connect = async () => ({ query, release() {} });
  try {
    await db.exec(await read('test/fixtures/transaction-transfer-schema.sql'));
    await db.exec(`
      CREATE TABLE sites(id int PRIMARY KEY);
      CREATE TABLE users(id int PRIMARY KEY,role text,name text);
      CREATE TABLE members(id int PRIMARY KEY,full_name text);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE user_approval_modules(user_id int,module text);
      CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
      CREATE TABLE farmers(id int PRIMARY KEY,site_id int,name text);
      CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_name text,booking_by text,status text);
      CREATE TABLE land_deals(id int PRIMARY KEY,site_id int,deal_no text,buyer_name text,status text);
      CREATE TABLE plot_commissions_v2(id int PRIMARY KEY,site_id int,plot_id int,farmer_id int,land_deal_id int,agent_id int,total_commission numeric,status text,updated_at timestamptz);
      CREATE TABLE vendor_commitments(id int PRIMARY KEY,site_id int,vendor_name text,work_title text,status text);
      CREATE TABLE misc_income_categories(id int PRIMARY KEY,name text,is_active boolean);
      CREATE TABLE plot_registries(id int PRIMARY KEY,site_id int,plot_no text,customer_name text);
      CREATE TABLE plot_registry_payments(id int PRIMARY KEY,source_plot_payment_id int);
      CREATE TABLE compliance_finance_links(expense_id int);
      CREATE TABLE bank_reconciliation_links(site_id int,candidate_entry_id int,candidate_source text);
      CREATE TABLE bank_accounts(id int PRIMARY KEY,site_id int);
      CREATE TABLE plot_money_transfers(id uuid PRIMARY KEY,source_payment_id int,amount numeric);
      INSERT INTO sites VALUES(1); INSERT INTO users VALUES(1,'admin','Admin'); INSERT INTO members VALUES(1,'Agent');
      INSERT INTO farmers VALUES(1,1,'Farmer'); INSERT INTO plots VALUES(1,1,'A1','Buyer','Dealer','BOOKED');
      INSERT INTO land_deals VALUES(1,1,'L1','Land buyer','open');
      INSERT INTO plot_commissions_v2 VALUES(1,1,1,NULL,NULL,1,100000,'Pending',NULL);
      INSERT INTO vendor_commitments VALUES(1,1,'Vendor','Work','open');
      INSERT INTO vendor_inventory_orders(site_id,vendor_name,item_name,qty_ordered,rate,order_date,commitment_id)
        VALUES(1,'Vendor','Cement',100,100,'2026-10-01',1);
      INSERT INTO misc_income_categories VALUES(1,'Other',true); INSERT INTO bank_accounts VALUES(1,1);
      INSERT INTO cash_flow_months(site_id,month,year,ledger_name,ledger_type,created_by)
        VALUES(1,10,2026,'PERSON','person',1);
    `);
    const sync = await read('src/migrations/086_cashflow_mode_bucket.js');
    await db.exec(sync.match(/const BUCKET_FN = `([\s\S]*?)`;/)[1]);
    await db.exec(sync.match(/const SYNC_FN = `([\s\S]*?)`;/)[1]);
    await functionsFrom(db, '016_cashflow_module_auto_sync.js', ['ensure_site_cashflow_month']);
    await functionsFrom(db, '118_credit_first_posting.js', ['financial_transaction_posts']);
    await functionsFrom(db, '104_approved_transaction_posting.js', ['sync_vendor_inventory_payment_cashflow']);
    await functionsFrom(db, '118_credit_first_posting.js', ['sync_vendor_inventory_order']);
    await functionsFrom(db, '019_vendor_payment_approval_sync.js', ['sync_daybook_from_vendor_payments', 'sync_cashflow_status_from_source']);
    await functionsFrom(db, '109_land_deals.js', ['sync_land_deal_payment_cashflow']);
    await functionsFrom(db, '110_misc_income.js', ['misc_income_particular', 'sync_misc_income_cashflow']);
    await functionsFrom(db, '134_pending_cheque_invariants.js', ['normalize_accounting_cheque_source', 'sync_accounting_cheque_mirror']);
    await functionsFrom(db, '125_universal_imprest_enforcement.js', ['preserve_daybook_financial_projection']);
    for (const table of ['farmer_payments', 'plot_payments', 'expenses', 'plot_commission_payments', 'vendor_payments', 'day_book']) {
      await db.exec(`CREATE TRIGGER trg_sync_cfe_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()`);
    }
    await db.exec(`
      CREATE TRIGGER trg_sync_daybook_vendor_payments AFTER INSERT OR UPDATE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION sync_daybook_from_vendor_payments();
      CREATE TRIGGER trg_sync_cfe_status_vendor_payments AFTER INSERT OR UPDATE ON vendor_payments FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();
      CREATE TRIGGER trg_sync_cfe_status_day_book AFTER INSERT OR UPDATE ON day_book FOR EACH ROW EXECUTE FUNCTION sync_cashflow_status_from_source();
      CREATE TRIGGER trg_preserve_daybook_financial_projection BEFORE INSERT OR UPDATE ON day_book FOR EACH ROW EXECUTE FUNCTION preserve_daybook_financial_projection();
      CREATE TRIGGER trg_sync_land_deal_payment_cashflow AFTER INSERT OR UPDATE OR DELETE ON land_deal_payments FOR EACH ROW EXECUTE FUNCTION sync_land_deal_payment_cashflow();
      CREATE TRIGGER trg_sync_misc_income_cashflow AFTER INSERT OR UPDATE OR DELETE ON misc_income_entries FOR EACH ROW EXECUTE FUNCTION sync_misc_income_cashflow();
      CREATE TRIGGER trg_sync_vendor_inventory_payment_cashflow AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_payment_cashflow();
      CREATE TRIGGER trg_sync_inv_payment AFTER INSERT OR UPDATE OR DELETE ON vendor_inventory_payments FOR EACH ROW EXECUTE FUNCTION sync_vendor_inventory_order();
    `);
    for (const table of Object.values(owners)) {
      const mode = table === 'plot_payments' ? 'payment_type' : 'payment_mode';
      await db.exec(`
        CREATE TRIGGER trg_aa_${table}_cheque_invariant BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION normalize_accounting_cheque_source('${mode}');
        CREATE TRIGGER trg_zz_${table}_cheque_mirror AFTER INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION sync_accounting_cheque_mirror('${table}','${mode}');
      `);
    }
    await up(pool);
    for (const [type, table] of Object.entries(owners)) {
      await t.test(`${type}: strict owner fields and native mirrors preserve the posted balance`, async () => {
        const original = (await query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,date,particular,credit,debit,cash_type,status,created_by,bank_account_id)
          VALUES(1,1,'2026-10-21','BANK',5000,0,'bank','approved',1,1) RETURNING id`)).rows[0];
        const options = await invoke(getTransferOptions, { source_type: 'personal_ledger', source_id: original.id });
        const body = {
          request_id: randomUUID(), target_type: type, target_id: 1,
          transfer_date: '2026-10-30', reason: 'Reclassify this amount using a paired transfer',
          entries: [{ source_type: 'personal_ledger', source_id: original.id, source_version: options.source.version,
            edits: { amount: 100, direction: 'credit', particular: 'BANK', payment_mode: 'TRANSFER' } }],
        };
        const before = Number((await query('SELECT SUM(credit-debit) AS amount FROM cash_flow_entries')).rows[0].amount);
        const preview = await invoke(previewTransfer, body);
        body.preview_hash = preview.preview_hash;
        const result = await invoke(transferEntry, body);
        const after = Number((await query('SELECT SUM(credit-debit) AS amount FROM cash_flow_entries')).rows[0].amount);
        assert.equal(after, before);
        const mirrors = (await query('SELECT * FROM cash_flow_entries WHERE source_module=$1 AND source_id=$2', [table, result.target.id])).rows;
        assert.equal(mirrors.length, 1);
        assert.equal(Number(mirrors[0].credit), 100);
        assert.equal(Number(mirrors[0].debit), 0);
        assert.equal(mirrors[0].created_by, 1, 'both legs must remain visible in creator-scoped Daybook views');
        if (type === 'vendor_payment') {
          const copies = (await query('SELECT * FROM day_book WHERE vendor_payment_id=$1', [result.target.id])).rows;
          assert.equal(copies.length, 1);
          assert.equal(copies[0].is_financial_projection, true);
          assert.equal((await query("SELECT COUNT(*)::int AS n FROM cash_flow_entries WHERE source_module='day_book' AND source_id=$1", [copies[0].id])).rows[0].n, 0);
        }
        // Transfer part onward from the real destination owner. This exercises
        // the opposite signed amount, source-parent lookup, and original-row
        // protection with every native owner schema as well.
        const onwardOptions = await invoke(getTransferOptions, { source_type: type, source_id: result.target.id });
        const onward = {
          request_id: randomUUID(), target_type: 'personal_ledger', target_id: 1,
          transfer_date: '2026-10-30', reason: 'Allocate part of this receipt onward',
          entries: [{ source_type: type, source_id: result.target.id, source_version: onwardOptions.source.version,
            edits: { amount: 25, direction: 'credit', particular: 'BANK', payment_mode: 'BANK' } }],
        };
        onward.preview_hash = (await invoke(previewTransfer, onward)).preview_hash;
        await invoke(transferEntry, onward);
        assert.equal(Number((await query('SELECT SUM(credit-debit) AS amount FROM cash_flow_entries')).rows[0].amount), before);
        assert.equal(Number((await query('SELECT SUM(credit-debit) AS amount FROM cash_flow_entries WHERE source_module=$1', [table])).rows[0].amount), 75);
        if (type === 'vendor_inventory_payment') {
          assert.equal(Number((await query('SELECT total_paid FROM vendor_inventory_orders WHERE id=1')).rows[0].total_paid), -75);
          const daybook = await read('src/controllers/daybook.controller.js');
          const dailyModuleQuery = daybook.match(/`(SELECT cfe\.\*, u\.name AS assigned_admin_name,[\s\S]*?\$3::text[\s\S]*?)`/)[1];
          const dailyRows = (await query(dailyModuleQuery, [1, '2026-10-30', '1'])).rows
            .filter((row) => row.source_module === 'vendor_inventory_payments');
          assert.equal(dailyRows.length, 2, 'daily Daybook includes both dated purchasing adjustments');
          assert.equal(dailyRows.reduce((sum, row) => sum + Number(row.credit) - Number(row.debit), 0), 75);
          assert.equal((await query(dailyModuleQuery, [1, '2026-10-21', '1'])).rows
            .filter((row) => row.source_module === 'vendor_inventory_payments').length, 0, 'new legs do not appear on the original date');
          // This startup migration used to touch every inventory owner and
          // would re-trigger signed mirror writes against immutable transfers.
          const migration = await read('src/migrations/104_approved_transaction_posting.js');
          const repair = migration.match(/await client\.query\(`(UPDATE vendor_inventory_payments SET updated_at[\s\S]*?)`\)/)[1];
          await db.exec(repair);
          assert.equal(Number((await query("SELECT SUM(credit-debit) AS amount FROM cash_flow_entries WHERE source_module='vendor_inventory_payments'")).rows[0].amount), 75);
        }
      });
    }
  } finally {
    pool.query = previous.query;
    pool.connect = previous.connect;
    await db.close();
  }
});
