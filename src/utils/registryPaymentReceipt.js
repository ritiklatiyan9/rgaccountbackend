import { buildVerifyUrl, ReceiptType } from './receiptToken.js';

/** Attach the signed public-verification URL used by registry payment receipts. */
export const withRegistryPaymentVerifyUrl = (payment, context = {}) => {
  if (!payment) return payment;
  const amount = Number(payment.amount) || 0;
  return {
    ...payment,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.PLOT,
      i: `registry_payment_${payment.id}`,
      a: Math.abs(amount),
      dr: amount < 0 ? 'OUT' : 'IN',
      d: payment.payment_date || null,
      pm: payment.payment_mode || null,
      pn: context.customer_name || context.buyer_name || null,
      pl: context.plot_no || null,
      sn: context.site_name || null,
      sy: context.site_city || null,
      ss: context.site_state || null,
    }),
  };
};
