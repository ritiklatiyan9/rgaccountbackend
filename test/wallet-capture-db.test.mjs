import test from 'node:test';
import assert from 'node:assert/strict';
import { up } from '../src/migrations/185_cash_wallets.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';

test('cash collection wallets reconcile real receipts without changing immutable history', {
  skip: !process.env.PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1);
  const database = { connect: async () => ({ query, release() {} }) };
  const balance = async user => Number((await query('SELECT balance FROM wallet_accounts WHERE user_id=$1', [user])).rows[0]?.balance || 0);
  const history = async user => (await query('SELECT * FROM wallet_entries WHERE user_id=$1 ORDER BY id', [user])).rows;
  let serial = 10;
  const entry = async (data = {}) => {
    const values = { id: serial++, created_by: 1, credit: 100, debit: 0, cash_type: 'CASH', status: 'pending', particular: 'Client cash receipt', ...data };
    const keys = Object.keys(values);
    await query(`INSERT INTO cash_flow_entries(${keys.join(',')}) VALUES(${keys.map((_, index) => '$' + (index + 1)).join(',')})`, Object.values(values));
    return values.id;
  };
  try {
    await query(`
      CREATE TABLE app_schema_migrations(version TEXT PRIMARY KEY);
      CREATE TABLE users(id INT PRIMARY KEY,role TEXT);
      INSERT INTO users VALUES(1,'sub_admin'),(2,'admin'),(3,'super_admin'),(4,'viewer');
      CREATE TABLE cash_flow_entries(id INT PRIMARY KEY,created_by INT,approved_by INT,credit NUMERIC,debit NUMERIC,
        cash_type TEXT,status TEXT,cheque_status TEXT,particular TEXT,source_module TEXT,source_id INT,
        entry_transfer_id UUID,is_imprest_internal BOOLEAN,is_firm_transaction BOOLEAN,to_firm_id INT,
        created_at TIMESTAMPTZ DEFAULT '2026-10-02');
      INSERT INTO cash_flow_entries(id,created_by,credit,debit,cash_type,status,created_at)
        VALUES(1,1,500,0,'CASH','approved','2020-01-01');
      ${postingPolicySql}
    `);
    for (const table of ['day_book','expenses','firm_transactions','plot_payments','plot_installment_payments',
      'land_deal_payments','misc_income_entries','farmer_payments','plot_commission_payments','vendor_payments',
      'vendor_inventory_payments','partner_profit_payments']) {
      await query(`CREATE TABLE ${table}(id INT PRIMARY KEY,created_by INT,status TEXT DEFAULT 'pending',payment_mode TEXT DEFAULT 'CASH',
        payment_type TEXT,cheque_status TEXT,created_at TIMESTAMPTZ DEFAULT '2026-10-02',cash_amount NUMERIC,
        entry_transfer_id UUID,money_transfer_id UUID,is_firm_to_firm_transfer BOOLEAN,transfer_group_id UUID,
        source_vendor_payment_id INT,entry_type TEXT,is_financial_projection BOOLEAN,expense_id INT,
        farmer_payment_id INT,commission_id INT,cash_flow_entry_id INT,firm_transaction_id INT,
        plot_payment_id INT,vendor_payment_id INT,imprest_allocation_id INT)`);
    }
    await up(database);
    await query("UPDATE wallet_settings SET tracking_started_at='2026-10-01'");

    await t.test('migration retries preserve the cutover and leave historical receipts untouched', async () => {
      await up(database);
      assert.equal((await query('SELECT tracking_started_at FROM wallet_settings')).rows[0].tracking_started_at.toISOString(), '2026-10-01T00:00:00.000Z');
      await query('UPDATE cash_flow_entries SET credit=800 WHERE id=1');
      assert.equal(await balance(1), 0);
      await query("INSERT INTO plot_payments(id,created_by,created_at) VALUES(1,1,'2020-01-01')");
      await entry({ source_module: 'plot_payments', source_id: 1 });
      assert.equal(await balance(1), 0, 'recreated mirror of a historical receipt must not mint money');
    });

    let receipt;
    await t.test('pending cash belongs to collector and approval never adds it twice', async () => {
      receipt = await entry({ approved_by: 2 });
      assert.equal(await balance(1), 100);
      assert.equal(await balance(2), 0);
      await query("UPDATE cash_flow_entries SET status='approved',approved_by=2 WHERE id=$1", [receipt]);
      assert.equal(await balance(1), 100);
      assert.equal((await history(1)).length, 1);
      await entry({ created_by: 2, credit: 25 });
      await entry({ created_by: 3, credit: 35 });
      assert.equal(await balance(2), 25);
      assert.equal(await balance(3), 35);
    });

    await t.test('edits, rejection, restoration and deletion append exact deltas', async () => {
      await query('UPDATE cash_flow_entries SET credit=160 WHERE id=$1', [receipt]);
      await query("UPDATE cash_flow_entries SET status='rejected' WHERE id=$1", [receipt]);
      await query("UPDATE cash_flow_entries SET status='pending' WHERE id=$1", [receipt]);
      await query('UPDATE cash_flow_entries SET created_by=2 WHERE id=$1', [receipt]);
      assert.equal(await balance(1), 0);
      assert.equal(await balance(2), 185);
      await query('DELETE FROM cash_flow_entries WHERE id=$1', [receipt]);
      assert.equal(await balance(2), 25);
      const ledger = await history(1);
      assert.deepEqual(ledger.map(row => Number(row.amount)), [100, 60, -160, 160, -160]);
      assert.deepEqual(ledger.map(row => row.kind), ['receipt','adjustment','reversal','receipt','reversal']);
      await assert.rejects(query('UPDATE wallet_entries SET description=$1 WHERE id=$2', ['Edited', ledger[0].id]), /immutable/);
      await assert.rejects(query('DELETE FROM wallet_entries WHERE id=$1', [ledger[0].id]), /immutable/);
      assert.equal((await history(1)).length, 5);
    });

    await t.test('bank, cheque, outgoings, unsupported users and synthetic accounting records do not collect cash', async () => {
      for (const cash_type of ['BANK','UPI','NEFT','CHEQUE','ADJUST']) await entry({ cash_type });
      await entry({ credit: 0, debit: 100 });
      await entry({ credit: -100 });
      await entry({ created_by: 4 });
      for (const source_module of ['plot_payments_person','imprest','imprest_requests','document_imprest',
        'document_imprest_requests','plot_commissions','plot_registry_payments']) await entry({ source_module, source_id: 1 });
      await entry({ entry_transfer_id: '00000000-0000-4000-8000-000000000001' });
      await entry({ is_imprest_internal: true });
      await entry({ is_firm_transaction: true, to_firm_id: 5 });
      assert.equal(await balance(1), 0);
      assert.equal(await balance(4), 0);
      const changedMode = await entry();
      await query("UPDATE cash_flow_entries SET cash_type='BANK' WHERE id=$1", [changedMode]);
      assert.equal(await balance(1), 0, 'cash-to-bank corrections reverse custody');
    });

    await t.test('every real module receipt uses its collector, including sign-encoded refunds', async () => {
      for (const table of ['day_book','expenses','firm_transactions','plot_payments','plot_installment_payments',
        'land_deal_payments','misc_income_entries','farmer_payments','plot_commission_payments','vendor_payments',
        'vendor_inventory_payments','partner_profit_payments']) {
        await query(`INSERT INTO ${table}(id,created_by) VALUES(2,1)`);
        await entry({ source_module: table, source_id: 2, created_by: null, credit: 0, debit: -10 });
      }
      assert.equal(await balance(1), 120);
      await query("INSERT INTO farmer_payments(id,created_by,payment_mode,cash_amount) VALUES(3,1,'SPLIT',-17)");
      await entry({ source_module: 'farmer_payments', source_id: 3, credit: 0, debit: -60, cash_type: 'bank', created_by: null });
      assert.equal(await balance(1), 137, 'split refund credits only physical cash');
    });

    await t.test('paired transfers, firm transfers and linked projections do not mint cash', async () => {
      await query(`INSERT INTO firm_transactions(id,created_by,is_firm_to_firm_transfer) VALUES(3,1,TRUE);
        INSERT INTO day_book(id,created_by,entry_type) VALUES(3,1,'IMPREST');
        INSERT INTO day_book(id,created_by,expense_id) VALUES(4,1,2);
        INSERT INTO vendor_inventory_payments(id,created_by,source_vendor_payment_id) VALUES(3,1,2);
        INSERT INTO plot_payments(id,created_by,entry_transfer_id) VALUES(3,1,'00000000-0000-4000-8000-000000000001');`);
      for (const [source_module, source_id] of [['firm_transactions',3],['day_book',3],['day_book',4],['vendor_inventory_payments',3],['plot_payments',3]]) {
        await entry({ source_module, source_id });
      }
      assert.equal(await balance(1), 137);
    });

    await t.test('firm direct row and owning mirror commit only one receipt without temporary history', async () => {
      const before = (await history(1)).length;
      await query('BEGIN');
      const direct = await entry({ credit: 75 });
      await query('INSERT INTO firm_transactions(id,created_by,cash_flow_entry_id) VALUES(4,1,$1)', [direct]);
      await entry({ source_module: 'firm_transactions', source_id: 4, credit: 75 });
      await query('COMMIT');
      assert.equal(await balance(1), 212);
      assert.equal((await history(1)).length, before + 1);
    });

    await t.test('transaction rollback and repeated writes never leak or duplicate receipts', async () => {
      const before = (await history(1)).length;
      await query('BEGIN');
      await entry({ credit: 400 });
      await query('ROLLBACK');
      assert.equal(await balance(1), 212);
      await query('BEGIN');
      const id = await entry({ credit: 30 });
      await query('UPDATE cash_flow_entries SET credit=45 WHERE id=$1', [id]);
      await query("UPDATE cash_flow_entries SET status='approved' WHERE id=$1", [id]);
      await query('COMMIT');
      assert.equal(await balance(1), 257);
      assert.equal((await history(1)).length, before + 1);
      await up(database);
      assert.equal(await balance(1), 257);
    });

    await t.test('linking an existing firm copy later removes its duplicate custody', async () => {
      const direct = await entry({ credit: 50 });
      assert.equal(await balance(1), 307);
      await query('UPDATE firm_transactions SET cash_flow_entry_id=$1 WHERE id=4', [direct]);
      // The former direct entry (75) becomes independent, while the newly
      // linked 50 receipt becomes a mirror and no longer owns any custody.
      assert.equal(await balance(1), 332);
      await query('UPDATE firm_transactions SET cash_flow_entry_id=NULL WHERE id=4');
      assert.equal(await balance(1), 382);
    });

    await t.test('invalid numeric values cannot poison balances or reserve calculations', async () => {
      for (const amount of ['NaN','Infinity','-Infinity']) {
        await assert.rejects(query("SELECT wallet_apply_delta(1,$1::numeric,'adjustment','Invalid',NULL,NULL)", [amount]), /finite/);
      }
      await assert.rejects(query("UPDATE wallet_accounts SET balance='NaN' WHERE user_id=1"), /check constraint/);
      await assert.rejects(query("UPDATE wallet_accounts SET reserved_balance='NaN' WHERE user_id=1"), /check constraint/);
      assert.equal(await balance(1), 382);
    });
  } finally { await pg.close(); }
});
