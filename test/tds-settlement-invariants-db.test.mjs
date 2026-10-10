import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up } from '../src/migrations/198_tds_financial_settlements.js';
import { settleTds } from '../src/services/tdsSettlement.service.js';

test('TDS database invariants protect linked owners, posting state, CA identity and dates', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1);
  const db = { query, connect: async () => ({ query, release() {} }) };
  try {
    await pg.exec(`
      CREATE TABLE sites(id int PRIMARY KEY); INSERT INTO sites VALUES(1);
      CREATE TABLE users(id int PRIMARY KEY,role text); INSERT INTO users VALUES(1,'admin');
      CREATE TABLE bank_accounts(id int PRIMARY KEY,site_id int,is_active boolean); INSERT INTO bank_accounts VALUES(1,1,true);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,cash_flow_month_id int,site_id int,date date,particular text,
        debit numeric DEFAULT 0,credit numeric DEFAULT 0,cash_type text,bank_account_id int,remarks text,created_by int,
        source_module text,source_id int,status text,approved_by int,approved_at timestamptz);
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,debit numeric,status text);
      CREATE TABLE plot_commission_payments(id int PRIMARY KEY,amount numeric,status text,payment_mode text,cheque_status text);
      CREATE TABLE tds_deductions(id serial PRIMARY KEY,site_id int,commission_payment_id int,source_table text,source_id int,
        payment_state text DEFAULT 'active',deduction_date date,gross_amount numeric,tds_amount numeric,section varchar(10),
        deposit_date date,challan_no varchar(40),notes text,updated_by int,updated_at timestamptz);
      CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
      CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE sql AS 'SELECT $2=''approved''';
      INSERT INTO expenses VALUES(1,1,2000,'approved'),(2,1,9800,'pending');
      INSERT INTO cash_flow_entries(site_id,date,debit,credit,cash_type,bank_account_id,status,source_module,source_id)
        VALUES(1,'2026-05-10',2000,0,'BANK',1,'approved','expenses',1);
      INSERT INTO tds_deductions(site_id,deduction_date,gross_amount,tds_amount,section)
        VALUES(1,'2026-05-01',100000,2000,'194H'),(1,'2026-05-01',10000,200,'194H'),(1,'2026-05-01',10000,200,'194H');
    `);
    await up(db);
    const rawSettlement = async ({ kind = 'government_direct', amount = 200, deduction = 2, caName = null, existingEntry = null, date = '2026-05-10' } = {}) => {
      await query('BEGIN');
      try {
        const { rows } = await query(`INSERT INTO tds_settlements(site_id,kind,date,amount,payment_mode,bank_account_id,
          challan_no,ca_name,existing_entry_id,request_id,request_fingerprint,created_by)
          VALUES(1,$1,$2,$3,$4,$5,'CHALLAN',$6,$7,$8,'test',1) RETURNING id`,
        [kind, date, amount, kind === 'government_via_ca' ? null : 'BANK', kind === 'government_via_ca' ? null : 1, caName, existingEntry, randomUUID()]);
        await query("UPDATE tds_deductions SET settlement_id=$1,deposit_date=$2,challan_no='CHALLAN' WHERE id=$3", [rows[0].id, date, deduction]);
        await query('COMMIT');
        return rows[0].id;
      } catch (error) { await query('ROLLBACK'); throw error; }
    };
    await t.test('linking a historical debit locks its native owner even when it has no synchronization callback', async () => {
      await rawSettlement({ kind: 'existing', amount: 2000, deduction: 1, existingEntry: 1 });
      await assert.rejects(query('UPDATE expenses SET debit=2001 WHERE id=1'), /funded TDS/);
      await assert.rejects(query('DELETE FROM expenses WHERE id=1'), /funded TDS/);
      assert.equal(Number((await query('SELECT debit FROM expenses WHERE id=1')).rows[0].debit), 2000);
    });
    await t.test('deferred validation rejects a pending withholding and rolls back its cash mirror', async () => {
      await query("UPDATE tds_deductions SET source_table='expenses',source_id=2,payment_state='pending' WHERE id=2");
      const before = (await query('SELECT COUNT(*)::int AS n FROM cash_flow_entries')).rows[0].n;
      await assert.rejects(rawSettlement(), /allocations/);
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM cash_flow_entries')).rows[0].n, before);
      assert.equal((await query('SELECT settlement_id FROM tds_deductions WHERE id=2')).rows[0].settlement_id, null);
    });
    await t.test('a CA challan must consume money funded to the same CA without another cash movement', async () => {
      await settleTds({ id: 1, role: 'admin' }, 1, { ids: [3], date: '2026-05-09', ca_name: 'CA One',
        payment_mode: 'BANK', bank_account_id: 1, request_id: randomUUID() }, 'ca_transfer', db);
      const before = (await query('SELECT COUNT(*)::int AS n FROM cash_flow_entries')).rows[0].n;
      await assert.rejects(rawSettlement({ kind: 'government_via_ca', deduction: 3, caName: 'CA Two' }), /allocations/);
      await rawSettlement({ kind: 'government_via_ca', deduction: 3, caName: 'CA One' });
      assert.equal((await query('SELECT COUNT(*)::int AS n FROM cash_flow_entries')).rows[0].n, before);
    });
    await t.test('future payment dates are rejected at the database boundary', async () => {
      await assert.rejects(rawSettlement({ date: '2099-01-01' }), /check constraint/);
    });
  } finally { await pg.close(); }
});
