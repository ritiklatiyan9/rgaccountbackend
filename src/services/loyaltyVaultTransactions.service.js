import { LOYALTY_VAULT_SOURCE_TABLES } from './loyaltyVaultContext.service.js';
import { isVaultAdmin } from './loyaltyVault.service.js';
import { walletReadQuery } from './walletRead.service.js';

// Read canonical cash transactions, including pending approval. The legacy
// migration-only mode is retained for archived migration verification.
// OFFSET 0 preserves parameterized primary-key lookups. Without this fence
// PostgreSQL joined full payment tables before filtering wallet candidate IDs.
const sourceSql = (pendingOnly = false) => [...LOYALTY_VAULT_SOURCE_TABLES].map(table => {
  const direct = table === 'cash_flow_entries';
  return `SELECT c.id AS cash_flow_entry_id,'${table}'::text AS source_table,t.id AS source_id,
    selected.holder_type,selected.holder_id,
    COALESCE(c.site_id,loyalty_vault_source_site('${table}',to_jsonb(t))) AS site_id,
    to_jsonb(t) AS source,to_jsonb(c) AS cash
    ${direct ? 'FROM wallet_cash_rows c CROSS JOIN LATERAL (SELECT c.*) t' : `FROM wallet_cash_rows c JOIN LATERAL (
      SELECT native.* FROM ${table} native WHERE native.id=c.source_id OFFSET 0
    ) t ON true`}
    CROSS JOIN wallet_mode w
    CROSS JOIN LATERAL (SELECT
      COALESCE(t.loyalty_vault_holder_type,CASE WHEN w.consolidated_at IS NOT NULL AND
        (COALESCE(t.created_at,c.created_at)>=w.consolidated_at
          OR EXISTS(SELECT 1 FROM wallet_sources WHERE cash_flow_entry_id=c.id)
          OR EXISTS(SELECT 1 FROM loyalty_vault_sources WHERE cash_flow_entry_id=c.id)) THEN 'user' END) AS holder_type,
      COALESCE(t.loyalty_vault_holder_id,t.created_by,c.created_by) AS holder_id) selected
    WHERE selected.holder_type IS NOT NULL AND selected.holder_id IS NOT NULL
    ${pendingOnly ? 'AND w.consolidated_at IS NULL' : ''}
    ${direct ? `AND COALESCE(NULLIF(c.source_module,''),'cash_flow_entries')='cash_flow_entries'
      AND NOT EXISTS(SELECT 1 FROM firm_transactions f WHERE f.cash_flow_entry_id=c.id)` : `AND c.source_module='${table}'`}`;
}).join('\nUNION ALL\n');

// Only these cash-flow IDs can belong to a wallet: tracked receipts, explicit
// source assignments, or new entries after consolidation. Discover IDs using
// indexed native columns before converting/joining any financial record.
const assignedCandidateIds = [...LOYALTY_VAULT_SOURCE_TABLES].filter(table => table !== 'cash_flow_entries').map(table => `
  SELECT c.id FROM ${table} t JOIN cash_flow_entries c ON c.source_module='${table}' AND c.source_id=t.id
  WHERE t.loyalty_vault_holder_type IS NOT NULL AND t.loyalty_vault_holder_id IS NOT NULL
  UNION SELECT c.id FROM ${table} t JOIN cash_flow_entries c ON c.source_module='${table}' AND c.source_id=t.id
  WHERE t.created_at >= (SELECT consolidated_at FROM wallet_mode)`).join('\nUNION\n');
const candidateCte = (pendingOnly = false) => `wallet_candidates AS MATERIALIZED (
  SELECT cash_flow_entry_id AS id FROM wallet_sources
  UNION SELECT cash_flow_entry_id FROM loyalty_vault_sources
  UNION SELECT id FROM cash_flow_entries WHERE loyalty_vault_holder_type IS NOT NULL AND loyalty_vault_holder_id IS NOT NULL
  UNION SELECT id FROM cash_flow_entries WHERE created_at >= (SELECT consolidated_at FROM wallet_mode)
  UNION ${assignedCandidateIds}
), wallet_cash_rows AS MATERIALIZED (
  SELECT c.* FROM wallet_candidates candidate JOIN LATERAL (
    SELECT cash.* FROM cash_flow_entries cash WHERE cash.id=candidate.id OFFSET 0
  ) c ON true
  ${pendingOnly ? 'WHERE (SELECT consolidated_at FROM wallet_mode) IS NULL' : ''}
)`;

// Materialize each stage once. Inlining the union expands JSON conversion,
// creator fallback and posting rules repeatedly into every pending/status
// predicate, tying up the shared pool on real production transaction volumes.
const transactionsCte = (pendingOnly = false) => `WITH wallet_mode AS (SELECT NULLIF(to_jsonb(s)->>'consolidated_at','')::timestamptz AS consolidated_at FROM loyalty_vault_settings s LIMIT 1), ${candidateCte(pendingOnly)}, assigned_sources AS MATERIALIZED (${sourceSql(pendingOnly)}), eligible_sources AS MATERIALIZED (
  SELECT a.*,s.organization_id,s.name AS site_name,
    COALESCE(u.name,m.full_name,'Former holder') AS holder_name,
    creator.name AS created_by_name,assigner.name AS assigned_by_name,
    vault_plot.id AS plot_id,to_jsonb(vault_plot)->>'plot_no' AS plot_no,
    to_jsonb(vault_plot)->>'block' AS plot_block,
    COALESCE(NULLIF(BTRIM(to_jsonb(vault_plot)->>'buyer_name'),''),NULLIF(BTRIM(source->>'buyer_name'),'')) AS buyer_name,
    UPPER(COALESCE(NULLIF(TRIM(source->>'payment_mode'),''),NULLIF(TRIM(source->>'payment_type'),''),
      NULLIF(TRIM(source->>'by_note'),''),NULLIF(TRIM(cash->>'cash_type'),''),'CASH')) AS payment_mode,
    COALESCE(source->>'status',cash->>'status','approved') AS source_status,
    NULLIF(UPPER(TRIM(COALESCE(source->>'cheque_status',cash->>'cheque_status'))),'') AS cheque_status,
    CASE WHEN (SELECT consolidated_at FROM wallet_mode) IS NOT NULL AND source_table='farmer_payments' AND UPPER(TRIM(source->>'payment_mode'))='SPLIT'
      THEN GREATEST(-COALESCE((source->>'cash_amount')::numeric,0),0)
      ELSE GREATEST(COALESCE((cash->>'credit')::numeric,0),0)+GREATEST(-COALESCE((cash->>'debit')::numeric,0),0) END AS credit,
    CASE WHEN (SELECT consolidated_at FROM wallet_mode) IS NOT NULL THEN 0::numeric
      ELSE GREATEST(COALESCE((cash->>'debit')::numeric,0),0)+GREATEST(-COALESCE((cash->>'credit')::numeric,0),0) END AS debit
  FROM assigned_sources a JOIN sites s ON s.id=a.site_id
    LEFT JOIN users u ON a.holder_type='user' AND u.id=a.holder_id
    LEFT JOIN members m ON a.holder_type='member' AND m.id=a.holder_id
    LEFT JOIN users creator ON creator.id=NULLIF(COALESCE(source->>'created_by',cash->>'created_by'),'')::integer
    LEFT JOIN users assigner ON assigner.id=NULLIF(source->>'loyalty_vault_assigned_by','')::integer
    LEFT JOIN plot_installments vault_installment ON a.source_table='plot_installment_payments' AND vault_installment.id=NULLIF(source->>'installment_id','')::integer
    LEFT JOIN plots vault_plot ON a.source_table IN ('plot_payments','plot_installment_payments')
      AND vault_plot.id=COALESCE(NULLIF(source->>'plot_id','')::integer,vault_installment.plot_id) AND vault_plot.site_id=a.site_id
  WHERE (a.holder_type<>'user' OR (u.organization_id=s.organization_id
    AND (u.role IN ('admin','super_admin','sub_admin') OR NULLIF(source->>'loyalty_vault_holder_type','') IS NOT NULL
      OR EXISTS(SELECT 1 FROM loyalty_vault_sources prior WHERE prior.cash_flow_entry_id=a.cash_flow_entry_id AND prior.holder_key='user:'||a.holder_id::text)
      OR EXISTS(SELECT 1 FROM wallet_sources prior WHERE prior.cash_flow_entry_id=a.cash_flow_entry_id AND prior.user_id=a.holder_id))))
    AND NOT COALESCE((source->>'is_imprest_internal')::boolean,false)
    AND NULLIF(source->>'entry_transfer_id','') IS NULL AND NULLIF(source->>'money_transfer_id','') IS NULL
    AND NOT COALESCE((source->>'is_firm_to_firm_transfer')::boolean,false) AND NULLIF(source->>'transfer_group_id','') IS NULL
    AND NOT (source_table='cash_flow_entries' AND COALESCE((source->>'is_firm_transaction')::boolean,false) AND NULLIF(source->>'to_firm_id','') IS NOT NULL)
    AND NOT (source_table='vendor_inventory_payments' AND NULLIF(source->>'source_vendor_payment_id','') IS NOT NULL)
    AND NOT (source_table='day_book' AND (UPPER(COALESCE(source->>'entry_type',''))='IMPREST'
      OR COALESCE((source->>'is_financial_projection')::boolean,false)
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['expense_id','farmer_payment_id','commission_id','cash_flow_entry_id','firm_transaction_id','plot_payment_id','vendor_payment_id','imprest_allocation_id']) field WHERE NULLIF(source->>field,'') IS NOT NULL)))
), posting AS MATERIALIZED (
  SELECT e.*,
    CASE WHEN financial_transaction_posts('credit',source_status,payment_mode,cheque_status) THEN credit ELSE 0 END AS posted_credit,
    CASE WHEN financial_transaction_posts('debit',source_status,payment_mode,cheque_status) THEN debit ELSE 0 END AS posted_debit
  FROM eligible_sources e
  WHERE (SELECT consolidated_at FROM wallet_mode) IS NULL OR
    ((payment_mode='CASH' OR (source_table='farmer_payments' AND payment_mode='SPLIT')) AND credit>0)
), assigned_transactions AS (
  SELECT p.*,posted_credit-posted_debit AS posted_amount,
    credit-posted_credit AS unposted_credit,debit-posted_debit AS unposted_debit,
    CASE WHEN LOWER(TRIM(source_status)) IN ('rejected','cancelled','deleted','void','voided') THEN 'rejected'
      WHEN cheque_status IN ('BOUNCED','RETURNED','REJECTED','CANCELLED') THEN 'bounced'
      WHEN (credit>posted_credit OR debit>posted_debit) AND cheque_status IS NOT NULL AND cheque_status<>'CLEARED' THEN 'pending_clearance'
      WHEN credit>posted_credit OR debit>posted_debit THEN 'pending_approval'
      ELSE 'posted' END AS status
  FROM posting p
)`;

export const vaultTransactionsCte = transactionsCte();
export const vaultPendingTransactionsCte = transactionsCte(true);

export const vaultTransactionScope = actor => ({
  clause: 'organization_id=$1 AND ($2::boolean OR (holder_type=\'user\' AND holder_id=$3))',
  params: [actor.organization_id,isVaultAdmin(actor),actor.id],
});

const pendingReads = new WeakMap();
export function pendingVaultTotals(actor, database, selected = null, siteId = null) {
  let reads = pendingReads.get(database);
  if (!reads) { reads = new Map(); pendingReads.set(database, reads); }
  const key = JSON.stringify([actor.organization_id, isVaultAdmin(actor), actor.id, selected?.type, selected?.id, siteId]);
  if (reads.has(key)) return reads.get(key);
  const pending = loadPendingVaultTotals(actor, database, selected, siteId).finally(() => reads.delete(key));
  reads.set(key, pending);
  return pending;
}

async function loadPendingVaultTotals(actor, database, selected, siteId) {
  const scope = vaultTransactionScope(actor);
  if (selected) {
    scope.clause += ' AND holder_type=$4 AND holder_id=$5';
    scope.params.push(selected.type,selected.id);
  }
  if (siteId != null) {
    scope.params.push(siteId);
    scope.clause += ` AND site_id=$${scope.params.length}`;
  }
  const { rows } = await walletReadQuery(database, `${vaultPendingTransactionsCte}
    SELECT holder_type,holder_id,sum(credit-posted_credit)::text AS pending_credit,
      sum(debit-posted_debit)::text AS pending_debit,count(*)::int AS pending_count
    FROM assigned_transactions WHERE ${scope.clause} AND status IN ('pending_clearance','pending_approval')
    GROUP BY holder_type,holder_id`,scope.params);
  return rows;
}

export function publicVaultTransaction(row) {
  const s=row.source,c=row.cash;
  return {
    id: row.cash_flow_entry_id, source_table: row.source_table, source_id: row.source_id,
    holder_type: row.holder_type, holder_id: row.holder_id, holder_name: row.holder_name,
    plot_no: row.plot_no,buyer_name: row.buyer_name,plot_block: row.plot_block,
    site_id: row.site_id, site_name: row.site_name, status: row.status, source_status: row.source_status,
    source_reviewed_at: s.approved_at || null,
    cheque_status: row.cheque_status, payment_mode: row.payment_mode==='SPLIT'?'CASH':row.payment_mode, source_payment_mode: row.payment_mode,
    credit: String(row.credit), debit: String(row.debit), posted_amount: String(row.posted_amount),
    pending_credit: ['pending_clearance','pending_approval'].includes(row.status) ? String(row.unposted_credit) : '0',
    pending_debit: ['pending_clearance','pending_approval'].includes(row.status) ? String(row.unposted_debit) : '0',
    transaction_date: c.date, transaction_time: s.transaction_time || c.transaction_time,
    created_at: s.created_at || c.created_at, created_by: s.created_by || c.created_by,
    created_by_name: row.created_by_name,assigned_by: s.loyalty_vault_assigned_by,assigned_by_name: row.assigned_by_name,
    description: c.particular || s.particular || s.description || s.narration || 'Assigned transaction',
    remarks: s.remarks || s.remark || s.note || c.remarks || '',
    reference: s.cheque_no || s.reference_no || s.bank_reference || s.transaction_id || '',
    source_details: { plot_id: row.plot_id || s.plot_id,plot_no: row.plot_no,buyer_name: row.buyer_name,plot_block: row.plot_block,
      parent_id: s.farmer_id || s.land_deal_id || s.firm_id || s.cash_flow_month_id || s.commitment_id || s.order_id,
      site_id: row.site_id, source_available: true },
  };
}
