const heldError = () => Object.assign(new Error('A website booking request is holding this plot. Review it in Booking Software → Website Management before changing its booking or status.'), {
  status: 409, statusCode: 409, code: 'WEBSITE_PLOT_HELD',
});

/** Call after locking the shared plots row, inside the writer's transaction.
 * Website reservation/approval uses that same lock, so the check and mutation
 * cannot race a new online hold. Older installations have no website tables. */
export async function assertNoWebsitePlotHold(db, plotId) {
  const { rows: tables } = await db.query("SELECT to_regclass('public.website_booking_requests') AS requests_table");
  if (!tables[0]?.requests_table) return;
  const { rows } = await db.query(`SELECT id FROM website_booking_requests WHERE plot_id=$1
    AND (status='PAYMENT_REVIEW' OR (status IN ('ORDER_CREATING','AWAITING_PAYMENT') AND hold_expires_at>now())) LIMIT 1`, [plotId]);
  if (rows.length) throw heldError();
}

/** Legacy registry records can identify a plot by project/number instead of
 * plot_id. Resolve and lock the same target used by their status promotion. */
export async function assertRegistryWebsitePlotNotHeld(db, registry) {
  const { rows } = await db.query(`SELECT id FROM plots
    WHERE ($1::integer IS NOT NULL AND id=$1)
      OR ($1::integer IS NULL AND site_id=$2 AND UPPER(plot_no)=UPPER($3))
    ORDER BY id DESC LIMIT 1 FOR UPDATE`, [registry.plot_id, registry.site_id, registry.plot_no]);
  if (rows[0]) await assertNoWebsitePlotHold(db, rows[0].id);
}
