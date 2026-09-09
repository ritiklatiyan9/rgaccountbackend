import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { up } from '../src/migrations/157_expense_cash_default.js';
import { getSiteBalanceDetail } from '../src/graphql/services/kpi.service.js';

// Default is a complete rollback-only preview; --apply commits the same checked
// repair. Identity, source amount, creator and site are pinned to the report.
const apply = process.argv.includes('--apply');
const db = await pool.connect();
const snapshot = async () => {
  const { rows: [account] } = await db.query(`SELECT
    (SELECT COALESCE(SUM(amount),0) FROM imprest_ledger WHERE user_id=12 AND site_id=5) AS balance,
    (SELECT COALESCE(SUM(amount),0) FROM imprest_debit_reservations WHERE user_id=12 AND site_id=5) AS reserved,
    (SELECT COALESCE(SUM(amount),0) FROM imprest_ledger WHERE user_id=12 AND site_id=5
      AND source_module='expense' AND reference_id=24365 AND type IN ('EXPENSE','ADJUSTMENT')) AS source_net`);
  const { rows: [date] } = await db.query("SELECT (((now() AT TIME ZONE 'Asia/Kolkata')::date + 1))::text AS tomorrow");
  return {
    balance: Number(account.balance), reserved: Number(account.reserved), sourceNet: Number(account.source_net),
    site: await getSiteBalanceDetail(5, '1900-01-01', date.tomorrow, db),
  };
};

try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout = '10s'");
  await db.query("SET LOCAL statement_timeout = '60s'");
  // Install the forward fix and repair the one source in the same transaction.
  const adapter = { connect: async () => ({
    query: (sql, args) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)
      ? Promise.resolve({ rows: [] }) : db.query(sql, args), release() {},
  }) };
  await up(adapter);
  const { rows: [source] } = await db.query(`SELECT e.id,e.site_id,e.created_by,e.debit,e.credit,
    e.payment_mode,e.status,e.date,e.remark,e.approved_by,e.approved_at,
    u.email,u.role,s.name AS site_name
    FROM expenses e JOIN users u ON u.id=e.created_by JOIN sites s ON s.id=e.site_id
    WHERE e.id=24365 FOR UPDATE OF e,u`);
  assert.ok(source, 'Reported expense must exist');
  assert.equal(source.site_id, 5);
  assert.equal(source.site_name, 'OM ASSOCIATES');
  assert.equal(source.created_by, 12);
  assert.equal(source.email.toLowerCase(), 'sunnys@gmail.com');
  assert.equal(source.role, 'sub_admin');
  assert.equal(Number(source.debit), 710);
  assert.equal(Number(source.credit), 0);
  assert.equal(source.status, 'approved');
  assert.equal(source.remark, 'UNN FOOD STAFF');
  assert.ok(['', 'CASH'].includes(String(source.payment_mode || '').trim().toUpperCase()));
  const before = await snapshot();
  assert.ok([0, -710].includes(before.sourceNet), 'Unexpected prior source posting');
  const { rows: [updated] } = await db.query(`UPDATE expenses SET payment_mode='CASH'
    WHERE id=24365 RETURNING id,site_id,created_by,debit,credit,payment_mode,status,date,remark,approved_by,approved_at`);
  for (const key of ['id','site_id','created_by','debit','credit','status','remark','approved_by']) {
    assert.equal(updated[key], source[key], `Repair must preserve ${key}`);
  }
  for (const key of ['date','approved_at']) assert.deepEqual(updated[key], source[key]);
  const after = await snapshot();
  const delta = -710 - before.sourceNet;
  assert.equal(after.sourceNet, -710);
  assert.equal(after.balance, before.balance + delta);
  assert.equal(after.reserved, before.reserved);
  for (const key of ['totalMoneyIn','totalMoneyOut','cashBalance','bankBalance','balanceBeforeImprest']) {
    assert.equal(after.site[key], before.site[key], `Source books must preserve ${key}`);
  }
  assert.equal(after.site.imprestHeld, before.site.imprestHeld + delta);
  assert.equal(after.site.siteBalance, before.site.siteBalance - delta);
  assert.equal(after.site.distributableBalance, before.site.distributableBalance - delta);
  // An exact repeat must have no additional financial effect.
  await db.query("UPDATE expenses SET payment_mode='CASH' WHERE id=24365");
  assert.deepEqual(await snapshot(), after);
  const { rows: postings } = await db.query(`SELECT id,user_id,site_id,type,amount,source_module,reference_id
    FROM imprest_ledger WHERE source_module='expense' AND reference_id=24365 ORDER BY id`);
  await db.query(apply ? 'COMMIT' : 'ROLLBACK');
  console.log(JSON.stringify({ applied: apply, expense: updated, before, after, postings }, null, 2));
} catch (error) {
  await db.query('ROLLBACK');
  console.error('Expense repair rolled back:', error.message);
  process.exitCode = 1;
} finally {
  db.release();
  await pool.end();
}
