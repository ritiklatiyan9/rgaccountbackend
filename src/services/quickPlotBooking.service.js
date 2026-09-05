const bookingError = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Keep the COMPANY → BOOKED transition and its first payment indivisible.
 * The row lock also prevents two operators from booking the same plot. */
export async function withCompanyPlotBooking({ pool, plotId, memberId, date, savePayment }) {
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
    const { rows: [bookedPlot] } = await client.query(
      `UPDATE plots SET buyer_name = $2, buyer_member_id = $4, status = 'BOOKED', booking_date = $3::date, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [plotId, member.full_name.trim().toUpperCase(), date, member.id],
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
