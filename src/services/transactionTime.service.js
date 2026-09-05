import { AsyncLocalStorage } from 'node:async_hooks';

export const TRANSACTION_TIME_TABLES = new Set([
  'day_book', 'expenses', 'farmer_payments', 'plot_payments', 'plot_installment_payments',
  'plot_registry_payments', 'plot_commissions', 'plot_commission_payments',
  'vendor_payments', 'vendor_inventory_payments', 'firm_transactions', 'cash_flow_entries',
  'misc_income_entries', 'land_deal_payments', 'imprest_allocations', 'imprest_ledger',
  'imprest_transfers', 'imprest_expense_requests', 'imprest_returns', 'payment_qrs',
]);
export const transactionTimeContext = new AsyncLocalStorage();

export function normalizeTransactionTime(value) {
  if (value == null || value === '' || value === 'unknown') return null;
  const time = String(value).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) {
    const error = new Error('Transaction time must be a valid time in HH:mm:ss format (IST)');
    error.statusCode = 400;
    throw error;
  }
  return time.length === 5 ? `${time}:00` : time;
}

export const currentTransactionTime = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date());

export function transactionTimeForWrite(fallback = currentTransactionTime()) {
  const context = transactionTimeContext.getStore();
  return context?.supplied ? context.value : fallback;
}

export function withTransactionTime(table, data) {
  if (!TRANSACTION_TIME_TABLES.has(table)) return data;
  const context = transactionTimeContext.getStore();
  if (Object.hasOwn(data, 'transaction_time')) return { ...data, transaction_time: normalizeTransactionTime(data.transaction_time) };
  return context?.supplied ? { ...data, transaction_time: context.value } : data;
}

export function transactionTimeMiddleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  const header = req.get('X-Transaction-Time');
  const supplied = header !== undefined || Object.hasOwn(req.body || {}, 'transaction_time');
  try {
    const value = supplied ? normalizeTransactionTime(header ?? req.body.transaction_time) : undefined;
    return transactionTimeContext.run({ supplied, value }, next);
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
}
