import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { buildPendingPaymentReport, buildPercentagePlan, todayInIndia, validatePendingFilters } from '../services/pendingPlotPayments.service.js';

export const pendingPlotPayments = asyncHandler(async (req, res) => {
  const siteId = Number(req.query.site_id);
  if (!Number.isSafeInteger(siteId) || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required.' });
  const today = todayInIndia();
  const filters = { today, dateFrom: req.query.date_from || today, dateTo: req.query.date_to || today, asOf: req.query.as_of || today };
  validatePendingFilters(filters);
  const visibility = await resolveEntryVisibility(req.user, 'plot_payments', req.query.created_by);
  const { rows: plots } = await pool.query(
    `SELECT id, plot_no, block, buyer_name, booking_by, TO_CHAR(booking_date, 'YYYY-MM-DD') AS booking_date,
            sale_price, status, plot_tag
       FROM plots WHERE site_id = $1 ORDER BY plot_no, id`, [siteId]
  );
  const ids = plots.map((plot) => plot.id);
  const [schedule, received] = ids.length ? await Promise.all([
    pool.query(`SELECT id, plot_id, installment_name, amount, TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, sort_order
                  FROM plot_installments WHERE plot_id = ANY($1::int[]) ORDER BY plot_id, sort_order, due_date, id`, [ids]),
    pool.query(`SELECT plot_id, installment_id, SUM(amount) AS amount FROM (
                  SELECT plot_id, NULL::int AS installment_id, amount FROM plot_payments
                   WHERE plot_id = ANY($1::int[]) AND ($2::int IS NULL OR created_by = $2)
                     AND date BETWEEN DATE '1900-01-01' AND $3::date
                     AND financial_transaction_posts('credit', status, payment_type, cheque_status)
                  UNION ALL
                  SELECT plot_id, installment_id, amount FROM plot_installment_payments
                   WHERE plot_id = ANY($1::int[]) AND ($2::int IS NULL OR created_by = $2)
                     AND payment_date BETWEEN DATE '1900-01-01' AND $3::date
                     AND financial_transaction_posts('credit', status, payment_mode, cheque_status)
                ) posted GROUP BY plot_id, installment_id`, [ids, visibility.creatorId, today]),
  ]) : [{ rows: [] }, { rows: [] }];
  res.json({ ...buildPendingPaymentReport({ plots, installments: schedule.rows, receipts: received.rows,
    ...filters, broker: String(req.query.broker || ''), search: String(req.query.search || ''),
  }), receipt_scope: visibility.creatorId == null ? 'all' : 'creator' });
});

/** Creates a reviewed percentage plan in the existing installment tables, so
 * tracking, receipts and reminders immediately use the same schedule. */
export const createPercentagePaymentPlan = asyncHandler(async (req, res) => {
  const plotId = Number(req.params.id);
  if (!Number.isSafeInteger(plotId) || plotId <= 0) return res.status(400).json({ message: 'A valid plot id is required.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT id, sale_price, TO_CHAR(booking_date, 'YYYY-MM-DD') AS booking_date
                                         FROM plots WHERE id = $1 FOR UPDATE`, [plotId]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Plot not found.' }); }
    const existing = await client.query('SELECT id FROM plot_installments WHERE plot_id = $1 LIMIT 1', [plotId]);
    if (existing.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'This plot already has a schedule. Update it in Installment Plans.' });
    }
    const plan = buildPercentagePlan({ bookingDate: rows[0].booking_date, salePrice: rows[0].sale_price, milestones: req.body.milestones });
    const created = await client.query(
      `INSERT INTO plot_installments (plot_id, installment_name, amount, due_date, sort_order)
       SELECT $1, name, amount, due_date, position FROM unnest($2::text[], $3::numeric[], $4::date[], $5::int[])
       AS schedule(name, amount, due_date, position) RETURNING *`,
      [plotId, plan.map((row) => row.installment_name), plan.map((row) => row.amount), plan.map((row) => row.due_date), plan.map((row) => row.sort_order)]
    );
    await client.query('UPDATE plots SET installments_enabled = true WHERE id = $1', [plotId]);
    await client.query('COMMIT');
    res.status(201).json({ installments: created.rows });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});
