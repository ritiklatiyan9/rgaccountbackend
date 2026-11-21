import { isAccountWhatsAppPaymentEligible } from './accountWhatsApp.spec.js';

// Keep these guards independent of providers and database connections. The
// outbox worker repeats them against current records immediately before send.
const normalized = (value) => String(value ?? '').trim().toUpperCase();

export function isAccountWhatsAppClient(member) {
  const roles = Array.isArray(member?.member_types) && member.member_types.length ? member.member_types : [member?.member_type];
  return roles.some((role) => normalized(role) === 'CLIENT')
    && normalized(member?.status || 'ACTIVE') === 'ACTIVE';
}

/** Missing and unknown modes are excluded, including legacy blank modes. */
export function classifyAccountWhatsAppPayment(event, payment) {
  if (!['PAYMENT_RECEIVED', 'PAYMENT_SENT', 'INSTALLMENT_RECEIVED', 'POOL_PAYMENT_RECEIVED'].includes(event)) return false;
  // Paired internal reallocations do not represent fresh customer money.
  if (payment?.money_transfer_id || payment?.money_transfer_role || payment?.entry_transfer_id) return false;
  return isAccountWhatsAppPaymentEligible({
    ...payment, payment_mode: (event === 'INSTALLMENT_RECEIVED' ? payment?.payment_mode : payment?.payment_type) ?? '',
  }, event);
}

export function accountPaymentEvent(source, payment) {
  const event = source === 'plot_payment'
    ? (Number(payment?.amount) < 0 ? 'PAYMENT_SENT' : 'PAYMENT_RECEIVED')
    : source === 'plot_installment_payment' ? 'INSTALLMENT_RECEIVED'
      : source === 'pool_money_receipt' ? 'POOL_PAYMENT_RECEIVED' : null;
  return event && classifyAccountWhatsAppPayment(event, payment) ? event : null;
}

export function isAccountWhatsAppBookingTransition(plot, previous = null) {
  return normalized(plot?.status) === 'BOOKED'
    && normalized(plot?.approval_status) === 'APPROVED'
    && normalized(previous?.status) !== 'BOOKED';
}
