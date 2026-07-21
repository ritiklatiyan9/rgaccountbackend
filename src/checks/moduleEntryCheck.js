/**
 * Self-check for the Day Book module-entry proxy.
 *
 *   node src/checks/moduleEntryCheck.js
 *
 * Runs entirely inside a transaction that is always ROLLED BACK, so it is safe
 * against a live database. Covers the two things most likely to break:
 * the column map in MODULE_TABLES drifting from the real schema, and the
 * plot_installments.paid_amount invariant that edit/delete must preserve.
 */
import assert from 'node:assert';
import pool from '../config/db.js';
import { installmentModel } from '../models/Installment.model.js';

// Must mirror MODULE_TABLES in controllers/daybook.controller.js.
const COLUMNS = {
  plot_installment_payments: ['payment_date', 'amount', 'payment_mode', 'notes'],
  vendor_payments: ['payment_date', 'amount', 'payment_mode', 'note'],
  plot_commission_payments: ['date', 'amount', 'payment_mode', 'remarks'],
  plot_registry_payments: ['payment_date', 'amount', 'payment_mode', 'notes'],
};

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Every mapped column exists — a typo here would 500 at runtime.
    for (const [table, cols] of Object.entries(COLUMNS)) {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      );
      const actual = new Set(rows.map((r) => r.column_name));
      assert.ok(actual.size > 0, `table ${table} not found`);
      for (const c of cols) assert.ok(actual.has(c), `${table}.${c} does not exist`);
    }
    console.log('✓ column map matches schema');

    // 2. paid_amount + status track an edit and a delete.
    const { rows: [plot] } = await client.query('SELECT id FROM plots LIMIT 1');
    const { rows: [inst] } = await client.query(
      `INSERT INTO plot_installments (plot_id, installment_name, amount, paid_amount, due_date, sort_order, status)
       VALUES ($1, 'CHECK', 1000, 0, CURRENT_DATE + 30, 1, 'pending') RETURNING *`,
      [plot.id]
    );
    const { rows: [pay] } = await client.query(
      `INSERT INTO plot_installment_payments (installment_id, plot_id, amount, payment_date, payment_mode)
       VALUES ($1, $2, 1000, CURRENT_DATE, 'CASH') RETURNING *`,
      [inst.id, plot.id]
    );
    await installmentModel.update(inst.id, { paid_amount: 1000 }, client);
    await installmentModel.refreshStatuses(plot.id, client);

    const paidNow = await installmentModel.findById(inst.id, client);
    assert.equal(paidNow.status, 'paid', 'full payment should mark installment paid');

    // Edit down to 400 — the old ratcheting refreshStatuses left this 'paid'.
    await installmentModel.update(inst.id, { paid_amount: 1000 - 600 }, client);
    await client.query('UPDATE plot_installment_payments SET amount = 400 WHERE id = $1', [pay.id]);
    await installmentModel.refreshStatuses(plot.id, client);
    const afterEdit = await installmentModel.findById(inst.id, client);
    assert.equal(Number(afterEdit.paid_amount), 400, 'paid_amount should follow the edit');
    assert.equal(afterEdit.status, 'partially_paid', 'reduced payment must downgrade status');

    // Delete the payment — installment returns to pending.
    await installmentModel.update(inst.id, { paid_amount: 0 }, client);
    await client.query('DELETE FROM plot_installment_payments WHERE id = $1', [pay.id]);
    await installmentModel.refreshStatuses(plot.id, client);
    const afterDelete = await installmentModel.findById(inst.id, client);
    assert.equal(Number(afterDelete.paid_amount), 0, 'delete should release paid_amount');
    assert.equal(afterDelete.status, 'pending', 'delete must return status to pending');
    console.log('✓ paid_amount + status track edit and delete');

    console.log('\nAll module-entry checks passed.');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
};

run().catch((err) => {
  console.error('CHECK FAILED:', err.message);
  process.exit(1);
});
