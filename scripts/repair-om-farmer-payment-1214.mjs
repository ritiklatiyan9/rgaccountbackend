import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pool from '../src/config/db.js';
import { installInTransaction, VERSION } from '../src/migrations/247_farmer_cashflow_creator.js';
import { writeAuditLog } from '../src/services/auditLog.service.js';

const TARGET_DATE = '2026-11-05';
const omit = (record, fields) => Object.fromEntries(Object.entries(record).filter(([key]) => !fields.includes(key)));

async function snapshot(client) {
  const { rows: [payment] } = await client.query('SELECT to_jsonb(fp) AS record FROM farmer_payments fp WHERE fp.id=1214');
  const { rows: [mirror] } = await client.query('SELECT to_jsonb(cfe) AS record FROM cash_flow_entries cfe WHERE cfe.id=76095');
  const { rows: daybook } = await client.query('SELECT to_jsonb(d) AS record FROM day_book d WHERE farmer_payment_id=1214 ORDER BY id');
  const { rows: wallet } = await client.query(`SELECT to_jsonb(e) AS record FROM loyalty_vault_entries e
    WHERE (source_table='farmer_payments' AND source_id=1214) OR cash_flow_entry_id=76095 ORDER BY id`);
  const { rows: imprest } = await client.query('SELECT to_jsonb(e) AS record FROM imprest_ledger e WHERE site_id=5 AND reference_id=1214 ORDER BY id');
  const { rows: totals } = await client.query(`SELECT 'cashflow' AS module,count(*)::int AS count,COALESCE(sum(credit-debit),0)::text AS amount FROM cash_flow_entries WHERE site_id=5
    UNION ALL SELECT 'farmer',count(*)::int,COALESCE(sum(fp.amount),0)::text FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id WHERE f.site_id=5
    UNION ALL SELECT 'wallet',count(*)::int,COALESCE(sum(amount),0)::text FROM loyalty_vault_entries WHERE site_id=5
    UNION ALL SELECT 'imprest',count(*)::int,COALESCE(sum(amount),0)::text FROM imprest_ledger WHERE site_id=5 ORDER BY module`);
  return { payment: payment?.record, mirror: mirror?.record, daybook, wallet, imprest, totals };
}

export async function repair({ apply = false, database = pool } = {}) {
  const client = await database.connect();
  let backupPath;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    const guardInstalled = await installInTransaction(client);
    await client.query('SELECT id FROM farmer_payments WHERE id=1214 FOR UPDATE');
    await client.query('SELECT id FROM cash_flow_entries WHERE id=76095 FOR UPDATE');
    const { rows: [scope] } = await client.query(`SELECT s.name AS site_name,s.organization_id,u.name AS creator_name
      FROM sites s JOIN farmers f ON f.site_id=s.id JOIN farmer_payments fp ON fp.farmer_id=f.id JOIN users u ON u.id=fp.created_by
      WHERE s.id=5 AND f.id=51 AND fp.id=1214 AND u.id=5 AND u.organization_id=s.organization_id`);
    assert.equal(scope?.site_name, 'OM ASSOCIATES');
    assert.equal(scope?.creator_name, 'RAVI SIVACH');
    const { rows: [proof] } = await client.query(`SELECT user_id,new_values#>>'{response,payment,created_by}' AS creator,
      new_values#>>'{response,payment,id}' AS payment FROM audit_logs WHERE id=52027 AND action='CREATE' AND outcome='SUCCESS'`);
    assert.deepEqual(proof, { user_id: 5, creator: '5', payment: '1214' }, 'Original creation evidence changed');
    const before = await snapshot(client);
    assert.equal(before.payment?.farmer_id, 51);
    assert.equal(before.payment.amount, -935000);
    assert.equal(before.payment.bank_amount, -935000);
    assert.equal(before.payment.cash_amount, 0);
    assert.equal(before.payment.created_by, 5);
    assert.equal(before.payment.status, 'approved');
    assert.equal(before.payment.approved_by, 7);
    assert.equal(before.payment.remarks, 'CASH TO BNK');
    assert.equal(before.payment.payment_mode, 'BANK');
    assert.ok(['2026-11-14', TARGET_DATE].includes(before.payment.date), 'Payment date changed since investigation');
    assert.equal(before.mirror?.site_id, 5);
    assert.equal(before.mirror.source_module, 'farmer_payments');
    assert.equal(before.mirror.source_id, 1214);
    assert.equal(before.mirror.debit, -935000);
    assert.equal(before.mirror.credit, 0);
    assert.equal(before.mirror.bank_account_id, 21);
    assert.ok(before.mirror.created_by === null || before.mirror.created_by === 5);
    assert.equal(before.daybook.length, 0, 'Related projection inventory changed');
    if (apply) {
      const backup = new URL(`../../reports/om-farmer-1214-before-${Date.now()}.json`, import.meta.url);
      await writeFile(backup, JSON.stringify({ savedAt: new Date().toISOString(), requestedDate: TARGET_DATE, migration: VERSION, before }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      backupPath = backup.pathname;
    }
    if (before.payment.date !== TARGET_DATE) {
      const updated = await client.query('UPDATE farmer_payments SET date=$1::date WHERE id=1214 AND created_by=5 AND farmer_id=51 RETURNING id', [TARGET_DATE]);
      assert.equal(updated.rowCount, 1);
    }
    await client.query(`UPDATE cash_flow_entries SET created_by=5 WHERE id=76095 AND site_id=5
      AND source_module='farmer_payments' AND source_id=1214 AND created_by IS DISTINCT FROM 5`);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const after = await snapshot(client);
    assert.equal(after.payment.date, TARGET_DATE);
    assert.equal(after.payment.created_by, 5);
    assert.equal(after.mirror.date, TARGET_DATE);
    assert.equal(after.mirror.created_by, 5);
    assert.deepEqual(omit(after.payment, ['date', 'updated_at']), omit(before.payment, ['date', 'updated_at']), 'Source business fields changed');
    assert.deepEqual(omit(after.mirror, ['date', 'updated_at', 'created_by']), omit(before.mirror, ['date', 'updated_at', 'created_by']), 'Ledger business fields changed');
    for (const key of ['daybook', 'wallet', 'imprest', 'totals']) assert.deepEqual(after[key], before[key], `${key} changed`);
    if (before.payment.date !== after.payment.date || before.mirror.created_by !== after.mirror.created_by) {
      await writeAuditLog({ organizationId: scope.organization_id, siteId: 5, action: 'UPDATE', eventType: 'DATA_CORRECTION',
        module: 'farmers', entityType: 'farmer_payment', entityId: 1214, transactionName: 'NEERAJ RANA - CASH TO BNK', amount: 935000,
        description: 'User-requested transaction-date correction to 5 November 2026; ledger creator restored from the original Ravi payment.',
        oldValues: { payment: before.payment, cashflow: before.mirror }, newValues: { payment: after.payment, cashflow: after.mirror },
        metadata: { operator: 'Codex maintenance', creation_audit_id: 52027, original_creator_id: 5, migration: VERSION, user_requested: true },
      }, client);
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { applied: apply, guardInstalled, paymentId: 1214, cashflowId: 76095, date: TARGET_DATE, createdBy: scope.creator_name,
      amount: 935000, financialValuesPreserved: true, approvedStatusPreserved: true, backupPath };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  repair({ apply: process.argv.includes('--apply') }).then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; }).finally(() => pool.end());
}
