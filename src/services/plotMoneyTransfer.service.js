import { currentTransactionDate, transactionDateEditable } from './transactionDate.service.js';
import { transactionTimeForWrite } from './transactionTime.service.js';
import { canUserViewEntry } from './entryVisibility.service.js';
import { transactionMovesMoney } from '../utils/transactionPosting.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const positiveId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;
export function transferInput(body, paymentId) {
  if (!positiveId(paymentId) || !positiveId(body.target_plot_id)) fail(400, 'Select a destination plot');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id || '')) fail(400, 'A transfer request ID is required');
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(body.amount)) || !Number.isSafeInteger(Math.round(Number(body.amount) * 100)) || Number(body.amount) <= 0 || Number(body.amount) > 9999999999999.99) fail(400, 'Enter a positive amount with at most two decimal places');
  const date = body.date || currentTransactionDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) fail(400, 'Enter a valid transfer date');
  return { id: body.request_id, paymentId: Number(paymentId), targetId: Number(body.target_plot_id), amount: Number(body.amount), date };
}

export async function executePlotMoneyTransfer(db, user, input) {
  // Lock the request key as well as the plots: retries and concurrent transfers
  // from different receipts on the same plot must not spend the same balance.
  // Probe on the transaction connection so migrations are picked up immediately,
  // without holding one connection while waiting for a second pool connection.
  const schema = await db.query("SELECT to_regclass('public.plot_money_transfers') IS NOT NULL AS present");
  if (!schema.rows[0]?.present) throw Object.assign(new Error('Plot transfers are temporarily unavailable. Please contact an administrator to enable them.'), {
    statusCode: 503, code: 'PLOT_MONEY_TRANSFERS_NOT_READY',
  });
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.id]);
  const source = (await db.query('SELECT * FROM plot_payments WHERE id = $1', [input.paymentId])).rows[0];
  if (!source || !await canUserViewEntry(user, 'plot_payments', source.created_by)) fail(404, 'Source payment not found');
  const plots = (await db.query('SELECT * FROM plots WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [[source.plot_id, input.targetId]])).rows;
  const from = plots.find(p => p.id === source.plot_id);
  const to = plots.find(p => p.id === input.targetId);
  if (!from || !to) fail(404, 'Destination plot not found');
  if (from.id === to.id) fail(400, 'Choose a different destination plot');
  if (!['admin', 'super_admin'].includes(user.role)) {
    for (const siteId of new Set([from.site_id, to.site_id])) {
      if (!(await db.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2', [user.id, siteId])).rows.length) fail(403, 'Access denied to this location');
    }
    const approval = await db.query("SELECT 1 FROM user_approval_modules WHERE user_id = $1 AND module = 'plot_payment'", [user.id]);
    if (!approval.rows.length) fail(403, 'Plot payment approval permission is required to post both transfer entries');
  }
  const existing = (await db.query('SELECT *, requested_date::text AS requested_date FROM plot_money_transfers WHERE id = $1', [input.id])).rows[0];
  if (existing) {
    if (existing.source_payment_id !== input.paymentId || existing.target_plot_id !== input.targetId || Number(existing.amount) !== input.amount || existing.created_by !== user.id || existing.requested_date !== input.date) fail(409, 'This request ID was already used for another transfer');
    return { transfer: existing, payments: (await db.query('SELECT * FROM plot_payments WHERE money_transfer_id = $1 ORDER BY amount', [input.id])).rows, replayed: true };
  }
  const receipt = (await db.query('SELECT * FROM plot_payments WHERE id = $1 FOR UPDATE', [input.paymentId])).rows[0];
  if (!receipt || receipt.plot_id !== from.id) fail(409, 'Source payment changed. Refresh and try again');
  if (receipt.status !== 'approved' || Number(receipt.amount) <= 0 || !transactionMovesMoney({ direction: 'credit', status: receipt.status, paymentMode: receipt.payment_type, chequeStatus: receipt.cheque_status })) fail(409, 'Approve the received credit and clear any cheque before transferring');
  if (['CANCELLED', 'COMPANY', 'RESALE'].includes(String(to.status).toUpperCase()) || String(to.plot_tag).toUpperCase() === 'OLD') fail(409, 'Select an active booked destination plot');
  const spent = (await db.query('SELECT COALESCE(SUM(amount), 0) AS amount FROM plot_money_transfers WHERE source_payment_id = $1', [receipt.id])).rows[0];
  if (Math.round(input.amount * 100) > Math.round((Number(receipt.amount) - Number(spent.amount)) * 100)) fail(409, 'Transfer exceeds the amount remaining on this receipt');
  const balance = (await db.query(`SELECT COALESCE(SUM(amount), 0) AS amount FROM plot_payments
    WHERE plot_id = $1 AND financial_transaction_posts('credit', status, payment_type, cheque_status)`, [from.id])).rows[0];
  if (Math.round(input.amount * 100) > Math.round(Number(balance.amount) * 100)) fail(409, 'Transfer exceeds the source plot balance');
  const requestedDate = input.date;
  if (!await transactionDateEditable(from.site_id, db) || !await transactionDateEditable(to.site_id, db)) input.date = currentTransactionDate();
  const transfer = (await db.query(`INSERT INTO plot_money_transfers
    (id,source_payment_id,source_plot_id,target_plot_id,amount,date,created_by,requested_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [input.id, receipt.id, from.id, to.id, input.amount, input.date, user.id, requestedDate])).rows[0];
  const time = transactionTimeForWrite();
  const payments = [];
  for (const [plot, sign, role, narration] of [
    [from, -1, 'debit', `TRANSFER FROM ${from.plot_no} TO ${to.plot_no}`],
    [to, 1, 'credit', `TRANSFER MONEY GET FROM ${from.plot_no} INTO ${to.plot_no}`],
  ]) {
    payments.push((await db.query(`INSERT INTO plot_payments
      (plot_id,site_id,date,payment_from,payment_type,amount,narration,buyer_name,booked_by,
       created_by,status,approved_by,approved_at,transaction_time,money_transfer_id,money_transfer_role)
      VALUES ($1,$2,$3,'TRANSFER','BANK',$4,$5,$6,$7,$8,'approved',$8,NOW(),$9,$10,$11) RETURNING *`,
    [plot.id, plot.site_id, input.date, sign * input.amount, narration.toUpperCase(), plot.buyer_name, plot.booking_by, user.id, time, input.id, role])).rows[0]);
  }
  return { transfer, payments, replayed: false };
}
