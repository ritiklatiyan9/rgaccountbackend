import { isDatabaseUnavailable } from '../utils/databaseError.js';

const errorMiddleware = (err, req, res, next) => {
  console.error(err.stack);
  if (isDatabaseUnavailable(err)) {
    res.set('Retry-After', '5');
    return res.status(503).json({
      message: 'The database is temporarily busy. Please try again in a few seconds.',
      code: 'DATABASE_UNAVAILABLE',
    });
  }
  const isInsufficientImprest = err.constraint === 'imprest_sufficient_balance';
  const isMissingImprestOwner = err.constraint === 'imprest_debit_owner_required';
  const isInsufficientSiteCash = err.constraint === 'imprest_site_cash_funding';
  const isImprestConflict = isInsufficientImprest || isMissingImprestOwner || isInsufficientSiteCash;
  const vaultAccess = ['loyalty_vault_assignment_access', 'loyalty_vault_holder_scope'].includes(err.constraint);
  const statusCode = (['loyalty_vault_holder_funds', 'cash_wallet_collector_locked'].includes(err.constraint) ? 409 : vaultAccess ? 403 : 0) || (['tds_workflow', 'project_unit_profile', 'plot_money_transfer_protected', 'transaction_transfer_protected', 'cheque_clearance_before_approval'].includes(err.constraint) ? 409 : 0) || Number(err.statusCode)
    || (err.code === 'LIMIT_FILE_SIZE' ? 413 : isImprestConflict ? 409 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? 'The uploaded file exceeds the 10 MB limit.'
    : err.code === 'PLOT_MONEY_TRANSFERS_NOT_READY'
      ? 'Plot transfers are temporarily unavailable. Please contact an administrator to enable them.'
      : (statusCode < 500 ? err.message : 'Something went wrong with it');
  let imprestDetails = {};
  if ((isInsufficientImprest || isInsufficientSiteCash) && err.detail) {
    try {
      imprestDetails = JSON.parse(err.detail);
    } catch {
      // PostgreSQL detail is optional; the human-readable message is enough.
    }
  }
  res.status(statusCode).json({
    message,
    code: isInsufficientSiteCash
      ? 'INSUFFICIENT_SITE_BALANCE'
      : isInsufficientImprest
      ? 'INSUFFICIENT_IMPREST'
      : isMissingImprestOwner
        ? 'IMPREST_OWNER_REQUIRED'
        : err.code || 'INTERNAL_ERROR',
    ...imprestDetails,
  });
};

export default errorMiddleware;
