const normal = (value) => String(value || '').trim().toUpperCase();
const modes = ['payment_mode', 'payment_type', 'cash_type', 'by_note', 'payment_from'];

export const chequeReadyForApproval = (entry) => {
  const cheque = normal(entry?.cheque_status);
  const isCheque = !!cheque || modes.some((key) => ['CHEQUE', 'CHECK'].includes(normal(entry?.[key])));
  return !isCheque || cheque === 'CLEARED';
};

// JSON field access also supports non-payment approval sources without cheque columns.
// Aliases are internal constants, never request values.
export const chequeReadySql = (alias) => {
  const row = `to_jsonb(${alias})`;
  const cheque = `UPPER(TRIM(COALESCE(${row}->>'cheque_status', '')))`;
  const isMode = modes.map(key => `UPPER(TRIM(COALESCE(${row}->>'${key}', ''))) IN ('CHEQUE', 'CHECK')`).join(' OR ');
  return `(${cheque} = 'CLEARED' OR (${cheque} = '' AND NOT (${isMode})))`;
};
