const normalizeStatus = status => String(status || '').trim().toUpperCase();

export const AVAILABLE_BOOKING_STATUSES = ['COMPANY', 'AVAILABLE', 'CREATED'];
export const PLOT_BOOKING_FIELDS = [
  'status', 'buyer_name', 'buyer_member_id', 'booking_by', 'booking_date',
  'original_plot_rate', 'discount_rate', 'discount_amount', 'plot_rate', 'sale_price', 'first_installment',
  'plot_commission', 'commission_rate', 'commission_enabled', 'commission_type', 'commission_value',
  'nominee_name', 'nominee_relation', 'nominee_phone', 'co_applicant_name', 'co_applicant_relation',
  'co_applicant_phone', 'co_applicant_aadhar', 'co_applicant_pan', 'co_applicants',
];
export const BOOKING_INSTALLMENT_FIELDS = [
  'installments_enabled', 'interest_enabled', 'interest_rate', 'interest_type',
  'grace_period_days', 'penalty_enabled', 'penalty_rate', 'penalty_type', 'free_to_sale_days',
];

export function isDirectPlotStatusChange(body, currentStatus) {
  if (typeof body?.status !== 'string') return false;
  const statusChanges = normalizeStatus(body.status) !== normalizeStatus(currentStatus);
  return Object.keys(body).every(key => key === 'status' || key === 'assigned_admin_id'
    || (key === 'booking_date' && statusChanges));
}

export function isDirectPlotBooking(body, plot) {
  if (normalizeStatus(body?.status) !== 'BOOKED' || !String(body?.buyer_name || '').trim()) return false;
  const currentStatus = normalizeStatus(plot.status);
  const canBook = AVAILABLE_BOOKING_STATUSES.includes(currentStatus)
    || (currentStatus === 'BOOKED' && !plot.buyer_member_id && !String(plot.buyer_name || '').trim());
  return canBook && Object.keys(body).every(key => PLOT_BOOKING_FIELDS.includes(key)
    || ['assigned_admin_id', 'booking_allocations', 'booking_installment_settings'].includes(key));
}

/** Validate delegation against the same active/site scope as the approver picker. */
export async function validatePlotApprover(db, siteId, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error('Select an admin to approve this plot.'), { status: 400, statusCode: 400 });
  }
  const { rows } = await db.query(`SELECT u.id FROM users u WHERE u.id = $1 AND u.is_active = true
    AND (u.role IN ('admin', 'super_admin') OR (u.role = 'sub_admin'
      AND EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = u.id AND us.site_id = $2)))`, [id, siteId]);
  if (!rows[0]) throw Object.assign(new Error('Select an active approver for this site.'), { status: 400, statusCode: 400 });
  return id;
}
