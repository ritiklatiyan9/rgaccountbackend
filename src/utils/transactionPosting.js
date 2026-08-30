const TERMINAL_STATUSES = new Set(['rejected', 'cancelled', 'deleted', 'void', 'voided']);
const CHEQUE_MODES = new Set(['CHEQUE', 'CHECK']);

const normalizeDirection = (value) => String(value || '').trim().toLowerCase();
const normalizeStatus = (value) => String(value ?? 'approved').trim().toLowerCase() || 'approved';
const normalizeMode = (value) => String(value || '').trim().toUpperCase();

/**
 * One accounting-posting rule for non-SQL calculations.
 *
 * Credits post immediately while they await approval. Debits post only after
 * approval. A cheque on either side posts only after it is CLEARED.
 */
export const transactionMovesMoney = ({ direction, status, paymentMode, chequeStatus }) => {
  const normalizedDirection = normalizeDirection(direction);
  const normalizedStatus = normalizeStatus(status);
  const normalizedMode = normalizeMode(paymentMode);
  const normalizedChequeStatus = normalizeMode(chequeStatus);

  if (TERMINAL_STATUSES.has(normalizedStatus)) return false;

  const isCheque = CHEQUE_MODES.has(normalizedMode) || normalizedChequeStatus.length > 0;
  if (isCheque && normalizedChequeStatus !== 'CLEARED') return false;

  if (normalizedDirection === 'credit') return true;
  if (normalizedDirection === 'debit') return normalizedStatus === 'approved';
  return false;
};

/** Build the canonical PostgreSQL predicate installed by migration 118. */
export const transactionPostsSql = ({
  direction,
  alias,
  statusColumn = 'status',
  modeColumn = 'payment_mode',
  chequeStatusColumn = 'cheque_status',
}) => `financial_transaction_posts(
  '${direction}',
  ${alias}.${statusColumn},
  ${alias}.${modeColumn},
  ${alias}.${chequeStatusColumn}
)`;

export default transactionMovesMoney;
