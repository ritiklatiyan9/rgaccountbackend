import { assertPoolSiteAccess, listPoolMoney, poolSchema } from './poolMoney.service.js';

const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };
const cents = value => Math.round(Number(value) * 100);

// Catch up receipts created before the shared database capture triggers were
// installed. New collections are enrolled inside the source INSERT transaction.
// No receipt dates, amounts, collectors, approval or clearance states are changed.
export async function poolEnrollmentPlan(db, user, siteId) {
  if (!['admin', 'super_admin'].includes(user?.role) || user.is_active === false) fail(403, 'An active administrator must run the account sync.');
  await assertPoolSiteAccess(db, user, siteId);
  const schema = await poolSchema(db);
  if (!schema.ready || !schema.automatic_enrollment) fail(503, 'Install and enable the Booking account sync triggers before enrolling receipts.');
  const report = await listPoolMoney(db, siteId);
  const owners = report.rows.filter(row => row.unposted_amount > 0);
  const receipts = owners.flatMap(row => row.payments.filter(payment => !payment.recorded && !payment.plot_payment_id)
    .map(payment => ({ kind: row.kind, owner_id: row.id, source_id: payment.source_id, reference: payment.receipt_no || row.reference,
      date: payment.date, amount: payment.amount, payment_from: payment.payment_from, created_by: payment.created_by })));
  return { site_id: Number(siteId), receipt_count: receipts.length,
    amount: receipts.reduce((sum, receipt) => sum + cents(receipt.amount), 0) / 100, receipts,
    owners: owners.map(row => ({ kind: row.kind, id: row.id, amount: row.unposted_amount,
      closed: !!row.plot_id || row.status === 'ALLOTTED' })) };
}

export async function enrollExistingPoolReceipts(database, user, siteId, { expectedAmount, expectedCount } = {}) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await assertPoolSiteAccess(db, user, siteId);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('pool_money_enrollment:'||$1::text))", [siteId]);
    const initial = await poolEnrollmentPlan(db, user, siteId);
    // The source trigger also locks a draw's parent before capturing its money.
    // Lock owners first so source saves and this catch-up use the same order.
    for (const owner of initial.owners.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id)) {
      const table = owner.kind === 'booking' ? 'bookings' : 'draw_registrations';
      await db.query(`SELECT id FROM ${table} WHERE id=$1 AND site_id=$2 FOR UPDATE`, [owner.id, siteId]);
    }
    const plan = await poolEnrollmentPlan(db, user, siteId);
    if (!Number.isFinite(Number(expectedAmount)) || expectedAmount == null || !Number.isSafeInteger(expectedCount)
      || cents(expectedAmount) !== cents(plan.amount) || expectedCount !== plan.receipt_count) {
      fail(409, 'Booking receipts changed. Review the sync plan before retrying.');
    }
    if (plan.owners.some(owner => owner.closed)) fail(409, 'An allotted booking has unlinked money. Resolve its original payment link before syncing.');
    for (const owner of plan.owners) {
      if (owner.kind === 'booking') await db.query('UPDATE bookings SET id=id WHERE id=$1 AND site_id=$2', [owner.id, siteId]);
      else await db.query(`UPDATE draw_payments SET id=id WHERE draw_registration_id=$1 AND plot_payment_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM pool_money_receipts r WHERE r.source_kind='draw' AND r.source_id=draw_payments.id)`, [owner.id]);
      await db.query(`INSERT INTO pool_money_events(source_kind,owner_id,site_id,event_type,detail,actor_user_id)
        VALUES($1,$2,$3,'RECEIPTS_AUTO_ENROLLED',$4,$5)`, [owner.kind, owner.id, siteId,
        { amount: owner.amount, source: 'booking_account_sync' }, user.id]);
    }
    const after = await listPoolMoney(db, siteId);
    if (cents(after.summary.unposted_amount) !== 0) fail(409, 'Some receipts could not be enrolled. The account sync was rolled back.');
    await db.query('COMMIT');
    return { site_id: Number(siteId), enrolled_count: plan.receipt_count, enrolled_amount: plan.amount, summary: after.summary };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
