/** Project-scoped notice rules. These estimates never post money or rewrite a sale price. */
export const OVERDUE_POLICY_KEY = 'installment_overdue_notice_policy_v1';
export const PENDING_OVERDUE_TEMPLATE_KEY = 'installment_overdue_requested_template_v1';
export const indiaDate = (value = new Date()) => value instanceof Date
  ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value)
  : String(value || '').slice(0, 10);

export function normalizeOverduePolicy(value) {
  if (!value || value.enabled !== true) return null;
  if (value.kind === 'annual_interest' && Number(value.annual_rate) > 0 && Number(value.annual_rate) <= 100) {
    return { enabled: true, kind: value.kind, annual_rate: Number(value.annual_rate), frequency: 'per_installment' };
  }
  if (value.kind === 'shop_price_increase' && Number(value.amount) > 0 &&
      ['once_per_shop', 'per_installment'].includes(value.frequency)) {
    return { enabled: true, kind: value.kind, amount: Number(value.amount), frequency: value.frequency };
  }
  return null;
}

export async function loadOverduePolicy(siteId, db) {
  const row = (await db.query(
    'SELECT setting_value FROM application_settings WHERE site_id=$1 AND setting_key=$2 LIMIT 1',
    [siteId, OVERDUE_POLICY_KEY],
  )).rows[0];
  return normalizeOverduePolicy(row?.setting_value);
}

export function overdueNotice(policy, installment, unitType, asOf = new Date()) {
  policy = normalizeOverduePolicy(policy);
  const due = indiaDate(installment.due_date);
  const today = indiaDate(asOf);
  const remaining = Number(installment.remaining);
  const days = Math.floor((Date.parse(today) - Date.parse(due)) / 86400000);
  if (!policy || !Number.isFinite(remaining) || remaining <= 0.005 || !Number.isFinite(days) || days <= 0) return null;
  if (policy.kind === 'shop_price_increase' && String(unitType).toLowerCase() !== 'shop') return null;
  const penalty = policy.kind === 'annual_interest'
    ? Math.round(remaining * policy.annual_rate / 100 * days / 365 * 100) / 100
    : policy.amount;
  return { policy, days_overdue: days, penalty_amount: penalty, as_of_date: today };
}

export function overdueDedupeKey(policy, installmentId, plotId, dueDate) {
  return policy.kind === 'shop_price_increase' && policy.frequency === 'once_per_shop'
    ? `INSTALLMENT_OVERDUE:SHOP:${plotId}`
    : `INSTALLMENT_OVERDUE:${installmentId}:${indiaDate(dueDate)}`;
}

export function overdueTemplateBody(policy) {
  const fixed = policy?.kind === 'shop_price_increase';
  const rule = fixed
    ? `An overdue installment attracts a Rs. ${Number(policy.amount).toLocaleString('en-IN')} increase in the shop price${policy.frequency === 'once_per_shop' ? ', once per shop' : ' per missed installment'}.`
    : `Overdue interest at ${Number(policy?.annual_rate || 18)}% per year is calculated daily only on the unpaid installment amount that has become due. Future installments are excluded.`;
  return `*Overdue installment penalty notice*\n\nDear {customer_name},\n\nYour {installment_name} for ${fixed ? 'Shop' : 'Plot'} {plot_no} at {project}, due on {due_date}, remains unpaid.\n*Unpaid installment amount:* {amount_due}\n\n${rule}\n\nPlease settle the overdue amount. If you have already paid, contact our office to reconcile your account.\n\nDefence Garden Group`;
}
