import { transactionMovesMoney } from '../utils/transactionPosting.js';

const TERMINAL = new Set(['rejected', 'cancelled', 'deleted', 'void', 'voided']);

/** Day Book includes commitments awaiting approval without approving the source. */
export function daybookAmountCounts({ direction, status, paymentMode, chequeStatus }) {
  const normalized = String(status ?? 'approved').trim().toLowerCase();
  if (TERMINAL.has(normalized)) return false;
  const cheque = ['CHEQUE', 'CHECK'].includes(String(paymentMode || '').trim().toUpperCase())
    || Boolean(String(chequeStatus || '').trim());
  return cheque ? transactionMovesMoney({ direction, status, paymentMode, chequeStatus })
    : ['credit', 'debit'].includes(direction);
}

// This projection is deliberately local to Day Book. The posted accounting
// ledger remains unchanged for balances, wallets and every other consumer.
// A single mirror owns each financial transaction; linked Day Book copies,
// registry mappings, person counter-legs and imprest are never counted twice.
const OWNER_TABLES = [
  'plot_payments', 'plot_installment_payments', 'farmer_payments', 'expenses',
  'plot_commission_payments', 'vendor_payments', 'vendor_inventory_payments',
  'firm_transactions', 'day_book', 'partner_profit_payments',
  'land_deal_payments', 'misc_income_entries', 'tds_settlements', 'pool_money_receipts',
];
const ownerJoins = OWNER_TABLES.map((table, i) =>
  `LEFT JOIN ${table} owner_${i} ON cfe.source_module = '${table}' AND owner_${i}.id = cfe.source_id`).join('\n');
const ownerJson = `COALESCE(${OWNER_TABLES.map((_, i) => `to_jsonb(owner_${i})`).join(', ')}, '{}'::jsonb)`;

export const DAYBOOK_LEDGER_SQL = `
  WITH source_rows AS NOT MATERIALIZED (
    SELECT cfe.*, ${ownerJson} AS owner,
      cfm.ledger_name, LOWER(COALESCE(cfm.ledger_type, '')) AS ledger_type,
      COALESCE(u.name, 'System') AS created_by_name, ba.name AS bank_account_name
    FROM cash_flow_entries cfe
    ${ownerJoins}
    LEFT JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
    LEFT JOIN users u ON u.id = cfe.created_by
    LEFT JOIN bank_accounts ba ON ba.id = cfe.bank_account_id
    WHERE cfe.site_id = $1
      AND cfe.date::date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      AND COALESCE(cfe.source_module, '') NOT IN
        ('imprest', 'imprest_requests', 'document_imprest', 'document_imprest_requests',
         'plot_commissions', 'plot_registry_payments')
      AND COALESCE(cfe.source_module, '') !~ '_person$'
  ), normalized AS NOT MATERIALIZED (
    SELECT source_rows.*,
      COALESCE(owner->>'status', status, 'approved') AS owner_status,
      COALESCE(owner->>'cheque_status', cheque_status) AS owner_cheque_status,
      COALESCE(owner->>'cheque_no', cheque_no) AS owner_cheque_no,
      NULLIF(CASE WHEN owner ? 'approved_by' THEN owner->>'approved_by'
        ELSE to_jsonb(source_rows)->>'approved_by' END, '')::int AS owner_approved_by,
      NULLIF(CASE WHEN owner ? 'approved_at' THEN owner->>'approved_at'
        ELSE to_jsonb(source_rows)->>'approved_at' END, '')::timestamptz AS owner_approved_at,
      COALESCE(NULLIF(owner->>'created_at', '')::timestamptz, created_at) AS source_created_at,
      COALESCE(owner->>'payment_type', owner->>'payment_mode', cash_type, 'CASH') AS raw_mode,
      source_module = 'farmer_payments' AND UPPER(owner->>'payment_mode') = 'SPLIT'
        AND COALESCE((owner->>'cash_amount')::numeric, 0) + COALESCE((owner->>'bank_amount')::numeric, 0) > 0 AS is_split
    FROM source_rows
    WHERE NOT (COALESCE(source_module, '') = 'day_book' AND UPPER(COALESCE(owner->>'entry_type', '')) = 'IMPREST')
  ), legs AS NOT MATERIALIZED (
    SELECT normalized.*, leg.suffix, leg.mode, leg.raw_debit, leg.raw_credit
    FROM normalized
    CROSS JOIN LATERAL (
      SELECT ''::text AS suffix, raw_mode AS mode, COALESCE(debit, 0) AS raw_debit, COALESCE(credit, 0) AS raw_credit
        WHERE NOT COALESCE(is_split, false)
      UNION ALL
      SELECT ':cash', 'CASH', COALESCE((owner->>'cash_amount')::numeric, 0), 0::numeric
        WHERE is_split AND COALESCE((owner->>'cash_amount')::numeric, 0) > 0
      UNION ALL
      SELECT ':bank', 'BANK', COALESCE((owner->>'bank_amount')::numeric, 0), 0::numeric
        WHERE is_split AND COALESCE((owner->>'bank_amount')::numeric, 0) > 0
    ) leg
    WHERE LOWER(TRIM(owner_status)) NOT IN ('rejected', 'cancelled', 'deleted', 'void', 'voided')
  )
  SELECT CONCAT(id, suffix) AS id, site_id, date::date AS entry_date,
    particular, remarks,
    CASE WHEN UPPER(TRIM(mode)) IN ('CHEQUE', 'CHECK') OR NULLIF(TRIM(owner_cheque_status), '') IS NOT NULL
      THEN CASE WHEN financial_transaction_posts(CASE WHEN raw_debit < 0 THEN 'credit' ELSE 'debit' END, owner_status, mode, owner_cheque_status) THEN raw_debit ELSE 0::numeric END
      ELSE raw_debit END AS debit,
    CASE WHEN UPPER(TRIM(mode)) IN ('CHEQUE', 'CHECK') OR NULLIF(TRIM(owner_cheque_status), '') IS NOT NULL
      THEN CASE WHEN financial_transaction_posts(CASE WHEN raw_credit < 0 THEN 'debit' ELSE 'credit' END, owner_status, mode, owner_cheque_status) THEN raw_credit ELSE 0::numeric END
      ELSE raw_credit END AS credit,
    raw_debit AS display_debit, raw_credit AS display_credit,
    ledger_bucket(mode) AS bucket, LOWER(mode) AS raw_mode,
    COALESCE(source_module, 'personal_ledger') AS source_key, source_id,
    owner_status AS status, owner_cheque_status AS cheque_status, owner_cheque_no AS cheque_no,
    owner_approved_by AS approved_by, owner_approved_at AS approved_at,
    (SELECT reviewer.name FROM users reviewer WHERE reviewer.id = owner_approved_by LIMIT 1) AS approved_by_name,
    COALESCE(voucher_url, owner->>'voucher_url') AS voucher_url,
    COALESCE(NULLIF(to_name, ''), NULLIF(owner->>'buyer_name', ''), NULLIF(ledger_name, ''), particular) AS entity_name,
    COALESCE(NULLIF(remarks, ''), NULLIF(ledger_name, '')) AS linked_detail,
    ledger_type, created_by_name, source_created_at AS created_at,
    cash_flow_month_id, assigned_admin_id, ''::text AS plot_tag,
    CASE WHEN suffix = ':cash' THEN NULL::int ELSE bank_account_id END AS bank_account_id,
    CASE WHEN suffix = ':cash' THEN NULL::text ELSE bank_account_name END AS bank_account_name
  FROM legs
  WHERE raw_debit <> 0 OR raw_credit <> 0
`;

export const daybookLedgerSource = (includePending = false) => includePending
  ? `(${DAYBOOK_LEDGER_SQL})` : 'ledger_entries';
