import { chequeDateOnly } from './chequeDates.service.js';

// These expressions use fixed application-owned SQL identifiers, never request text.
export const chequeLedgerSql = (alias) => `(UPPER(TRIM(COALESCE(${alias}.cash_type, ''))) IN ('CHEQUE', 'CHECK') OR NULLIF(TRIM(COALESCE(${alias}.cheque_status, '')), '') IS NOT NULL)`;

export const daybookLedgerDateSql = (ledger = 'le', mirror = 'creator_cfe') => `CASE
  WHEN UPPER(TRIM(COALESCE(${ledger}.raw_mode, ''))) IN ('CHEQUE', 'CHECK')
    OR NULLIF(TRIM(COALESCE(${ledger}.cheque_status, '')), '') IS NOT NULL
  THEN CASE WHEN UPPER(TRIM(COALESCE(${ledger}.cheque_status, ''))) = 'CLEARED' THEN ${mirror}.cheque_transaction_date END
  ELSE ${ledger}.entry_date
END`;

export const daybookMirrorDateSql = (alias = 'cfe') => `CASE WHEN ${chequeLedgerSql(alias)}
  THEN CASE WHEN UPPER(TRIM(COALESCE(${alias}.cheque_status, ''))) = 'CLEARED' THEN ${alias}.cheque_transaction_date END
  ELSE ${alias}.date END`;

// Native source reads keep their full editable records, while matching cheques
// by their ledger clearing date. The two site-scoped subqueries can be hashed.
export function daybookSourceDatePredicate(sourceModule, alias) {
  const chequeIds = `SELECT cheque_cfe.source_id FROM cash_flow_entries cheque_cfe
    WHERE cheque_cfe.site_id = $1 AND cheque_cfe.source_module = '${sourceModule}'
      AND cheque_cfe.source_id IS NOT NULL AND ${chequeLedgerSql('cheque_cfe')}`;
  return `((${alias}.date = $2 AND ${alias}.id NOT IN (${chequeIds}))
    OR ${alias}.id IN (${chequeIds}
      AND UPPER(TRIM(COALESCE(cheque_cfe.cheque_status, ''))) = 'CLEARED'
      AND cheque_cfe.cheque_transaction_date = $2::date))`;
}

export function daybookEntryDate(entry) {
  const cheque = [entry.payment_mode, entry.payment_type, entry.payment_from, entry.cash_type]
    .some(mode => ['CHEQUE', 'CHECK'].includes(String(mode || '').trim().toUpperCase()))
    || Boolean(String(entry.cheque_status || '').trim());
  if (!cheque) return chequeDateOnly(entry.date || entry.entry_date);
  return String(entry.cheque_status || '').trim().toUpperCase() === 'CLEARED'
    ? chequeDateOnly(entry.cheque_transaction_date) : null;
}
