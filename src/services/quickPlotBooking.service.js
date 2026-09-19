import { validatePlotApprover } from './plotApproval.service.js';
const bookingError = (status, code, message) => Object.assign(new Error(message), { status, statusCode: status, code });

/** Keep the COMPANY → BOOKED transition and its first payment indivisible.
 * The row lock also prevents two operators from booking the same plot. */
export async function withCompanyPlotBooking({ pool, plotId, memberId, date, savePayment, requestedBy, assignedAdminId, deferBooking = false }) {
  if (!Number.isSafeInteger(Number(memberId)) || Number(memberId) <= 0) {
    throw bookingError(400, 'BOOKING_CLIENT_REQUIRED', 'Select a user to book this plot.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [plot] } = await client.query('SELECT * FROM plots WHERE id = $1 FOR UPDATE', [plotId]);
    if (!plot) throw bookingError(404, 'PLOT_NOT_FOUND', 'Plot not found.');
    if (String(plot.status || '').trim().toUpperCase() !== 'COMPANY') {
      throw bookingError(409, 'PLOT_BOOKING_CHANGED', 'This plot is no longer available for booking. Select the plot again to review its current buyer.');
    }
    const { rows: [member] } = await client.query(
      `SELECT id, full_name FROM members
        WHERE id = $1 AND site_id = $2 AND status = 'ACTIVE' FOR SHARE`,
      [Number(memberId), plot.site_id],
    );
    if (!member?.full_name?.trim()) {
      throw bookingError(400, 'BOOKING_CLIENT_UNAVAILABLE', 'Select an active user registered in this site.');
    }
    const reviewerId = requestedBy
      ? await validatePlotApprover(client, plot.site_id, assignedAdminId || plot.assigned_admin_id)
      : plot.assigned_admin_id;
    if (deferBooking) {
      const result = await savePayment(client);
      if (!result.rows[0]) throw bookingError(409, 'PLOT_BOOKING_CHANGED', 'The plot changed. Select it again before saving.');
      const deferred = await client.query(
        `UPDATE plot_payments SET pending_booking_member_id = $2, buyer_name = $3,
          assigned_admin_id = $4 WHERE id = $1 RETURNING *`,
        [result.rows[0].id, member.id, member.full_name.trim().toUpperCase(), reviewerId || null],
      );
      await client.query('COMMIT');
      return { result: deferred, bookedPlot: null };
    }
    const { rows: [bookedPlot] } = await client.query(
      `UPDATE plots SET buyer_name = $2, buyer_member_id = $4, status = 'BOOKED', booking_date = $3::date, updated_at = NOW(),
        assigned_admin_id = $5, approval_requested_by = COALESCE($6, created_by)
        WHERE id = $1 RETURNING *`,
      [plotId, member.full_name.trim().toUpperCase(), date, member.id, reviewerId || null, requestedBy || null],
    );
    const result = await savePayment(client);
    if (!result.rows[0]) throw bookingError(409, 'PLOT_BOOKING_CHANGED', 'The plot changed. Select it again before saving.');
    await client.query('COMMIT');
    return { result, bookedPlot };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Caller holds the payment lock and owns the clearance transaction. */
export async function completeDeferredChequeBooking(db, payment) {
  if (!payment.pending_booking_member_id) return;
  const { rows: [plot] } = await db.query('SELECT * FROM plots WHERE id = $1 FOR UPDATE', [payment.plot_id]);
  if (!plot || String(plot.status).toUpperCase() !== 'COMPANY') {
    throw bookingError(409, 'PLOT_BOOKING_CHANGED', 'This cheque was for an available plot that has since changed. Review its buyer before clearing the cheque.');
  }
  const { rows: [member] } = await db.query(
    `SELECT id, full_name FROM members WHERE id = $1 AND site_id = $2 AND status = 'ACTIVE' FOR SHARE`,
    [payment.pending_booking_member_id, plot.site_id],
  );
  if (!member) throw bookingError(409, 'BOOKING_CLIENT_UNAVAILABLE', 'The cheque buyer is no longer active in this site. Review the buyer before clearing.');
  const reviewerId = await validatePlotApprover(db, plot.site_id, payment.assigned_admin_id);
  await db.query(`UPDATE plots SET buyer_name = $2, buyer_member_id = $3, status = 'BOOKED',
    booking_date = $4, assigned_admin_id = $5, approval_requested_by = $6, updated_at = NOW()
    WHERE id = $1`, [plot.id, member.full_name.trim().toUpperCase(), member.id, payment.date, reviewerId, payment.created_by]);
  await db.query('UPDATE plot_payments SET pending_booking_member_id = NULL WHERE id = $1', [payment.id]);
}
