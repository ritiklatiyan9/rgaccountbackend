import pool from '../config/db.js';
import { TDS_SOURCES } from './paymentTds.service.js';

const tables = new Set([...Object.values(TDS_SOURCES).map(source => source.table), 'plot_commission_payments']);
const prefixes = { expense: 'expenses', fp: 'farmer_payments', comm: 'plot_commissions', cf: 'cash_flow_entries', ft: 'firm_transactions', vp: 'vendor_payments', vip: 'vendor_inventory_payments', pcp: 'plot_commission_payments', ppp: 'partner_profit_payments' };
const payoutFields = new Map(Object.values(TDS_SOURCES).map(source => [source.table, source.amount || 'amount']));
payoutFields.set('plot_commission_payments', 'amount');
const fields = ['tds_amount','tds_rate','tds_mode','tds_section','tds_module','tds_member_id','tds_deductee_name','tds_pan','tds_aadhaar'];
export function sourceOf(entry) {
  for (const [key, table] of [['expense_id','expenses'],['farmer_payment_id','farmer_payments'],['commission_id','plot_commissions'],['cash_flow_entry_id','cash_flow_entries'],['firm_transaction_id','firm_transactions']]) {
    if (entry[key]) return { table, id: entry[key] };
  }
  if (tables.has(entry.source_key) && entry.source_id) return { table: entry.source_key, id: entry.source_id };
  if (entry.source_key === 'tds_settlements') return null;
  if (entry.source_key === 'day_book' && entry.source_id) return { table: 'day_book', id: entry.source_id };
  if (entry.source_key === 'personal_ledger' && entry.entry_date) return { table: 'cash_flow_entries', id: String(entry.id).split(':')[0] };
  if (typeof entry.id === 'number') return { table: 'day_book', id: entry.id };
  const [prefix, id] = String(entry.id).split('_');
  return prefixes[prefix] ? { table: prefixes[prefix], id } : null;
}

// A mirror is a net-money view. Keep its TDS form snapshot on the native owner
// so changing a date or note cannot apply a second deduction to the net amount.
export async function attachDayBookTds(entries, db = pool) {
  const groups = new Map();
  for (const entry of entries) {
    const source = sourceOf(entry);
    if (!source || !Number.isSafeInteger(Number(source.id)) || Number(source.id) <= 0) continue;
    if (!groups.has(source.table)) groups.set(source.table, new Set());
    groups.get(source.table).add(Number(source.id));
  }
  const snapshots = new Map();
  await Promise.all([...groups].map(async ([table, ids]) => {
    const commission = table === 'plot_commission_payments';
    const select = fields.map(field => field === 'tds_module' && commission
      ? `CASE WHEN master.plot_id IS NOT NULL THEN 'plot_commission' WHEN master.farmer_id IS NOT NULL THEN 'land_purchase_commission' ELSE 'land_sale_commission' END AS tds_module`
      : `to_jsonb(s)->>'${field}' AS ${field}`).join(', ');
    const payoutField = payoutFields.get(table) || 'debit';
    const { rows } = await db.query(`SELECT s.id, COALESCE((to_jsonb(s)->>'${payoutField}')::numeric, 0) AS net_amount, ${select} FROM ${table} s ${commission ? 'LEFT JOIN plot_commissions_v2 master ON master.id=s.plot_commission_id' : ''} WHERE s.id=ANY($1::int[])`, [[...ids]]);
    for (const row of rows) snapshots.set(`${table}:${row.id}`, row);
  }));
  for (const entry of entries) {
    const source = sourceOf(entry);
    const snapshot = source && snapshots.get(`${source.table}:${source.id}`);
    if (snapshot) {
      for (const field of fields) entry[field] = snapshot[field];
      const net = Number(snapshot.net_amount) || 0;
      entry.net_amount = net;
      entry.tds_metadata_scope = 'source_payment';
      entry.gross_amount = Math.round((net + (Number(snapshot.tds_amount) || 0)) * 100) / 100;
    }
  }
  return entries;
}

// A register row is the withholding owner. A split cash/bank ledger row must
// never add its withholding twice. Legacy commission register rows predate the
// native payment_state snapshot and continue to derive state from their owner.
export const ACTIVE_SOURCE_TDS_SQL = `
  SELECT t.id, t.site_id, t.deduction_date AS entry_date,
         COALESCE(t.source_table, CASE WHEN t.commission_payment_id IS NOT NULL THEN 'plot_commission_payments' END) AS source_key,
         COALESCE(t.source_id, t.commission_payment_id) AS source_id,
         t.tds_amount, t.gross_amount
    FROM tds_accounting_deductions t
   WHERE t.tds_amount > 0 AND t.accounting_state = 'active'
`;

// Historical challans may be linked to an already-booked cash movement. That
// movement remains in cash balances, but is now a liability settlement rather
// than a second operating cost.
export const excludeLinkedTdsSettlement = (alias = 'le') => `NOT EXISTS (
  SELECT 1 FROM tds_settlements settlement
   WHERE settlement.existing_entry_id = NULLIF(SPLIT_PART(${alias}.id::text, ':', 1), '')::int
)`;

export const excludeSourceLinkedTdsSettlement = (table, id = `${table}.id`) => `NOT EXISTS (
  SELECT 1 FROM tds_settlements settlement
  JOIN cash_flow_entries linked ON linked.id = settlement.existing_entry_id
  WHERE linked.source_module = '${table}' AND linked.source_id = ${id}
)`;

export const OPERATING_TDS_SQL = `
  SELECT t.* FROM (${ACTIVE_SOURCE_TDS_SQL}) t
   WHERE EXISTS (
     SELECT 1 FROM ledger_entries le
      WHERE le.site_id = t.site_id AND le.source_key = t.source_key AND le.source_id = t.source_id
        AND le.ledger_type <> 'person'
        AND le.source_key NOT IN (
          'firm_transactions', 'personal_ledger', 'plot_payments',
          'plot_installment_payments', 'land_deal_payments', 'day_book',
          'misc_income_entries', 'partner_profit_payments', 'tds_settlements'
        )
        AND ${excludeLinkedTdsSettlement('le')}
   )
`;

export async function attachDayBookTdsSettlements(entries, db = pool) {
  if (!entries.length) return entries;
  const ids = new Set();
  const cashflowIds = new Set();
  const ownerKeys = new Set();
  for (const entry of entries) {
    if (entry.source_key === 'tds_settlements' && entry.source_id) ids.add(Number(entry.source_id));
    if (entry.cash_flow_entry_id) cashflowIds.add(Number(entry.cash_flow_entry_id));
    if (entry.entry_date) cashflowIds.add(Number(String(entry.id).split(':')[0]));
    const source = sourceOf(entry);
    if (source) ownerKeys.add(`${source.table}:${source.id}`);
  }
  const { rows } = await db.query(`
    SELECT s.id, s.kind, s.amount, s.challan_no, s.ca_name, s.transaction_id,
           cfe.id AS cash_flow_entry_id, cfe.source_module, cfe.source_id
      FROM tds_settlements s
      LEFT JOIN cash_flow_entries cfe ON cfe.id = s.existing_entry_id
     WHERE s.id = ANY($1::int[]) OR s.existing_entry_id = ANY($2::int[])
        OR CONCAT(cfe.source_module, ':', cfe.source_id) = ANY($3::text[])
  `, [[...ids], [...cashflowIds].filter(Number.isSafeInteger), [...ownerKeys]]);
  const bySettlement = new Map(rows.map(row => [Number(row.id), row]));
  const byCashflow = new Map(rows.filter(row => row.cash_flow_entry_id).map(row => [Number(row.cash_flow_entry_id), row]));
  const byOwner = new Map(rows.filter(row => row.source_module).map(row => [`${row.source_module}:${row.source_id}`, row]));
  for (const entry of entries) {
    const source = sourceOf(entry);
    const cashflowId = entry.cash_flow_entry_id || (entry.entry_date ? Number(String(entry.id).split(':')[0]) : null);
    const settlement = entry.source_key === 'tds_settlements' ? bySettlement.get(Number(entry.source_id))
      : byCashflow.get(Number(cashflowId)) || (source && byOwner.get(`${source.table}:${source.id}`));
    if (!settlement) continue;
    entry.native_source_key = entry.source_key;
    entry.native_source_id = entry.source_id;
    entry.source_key = 'tds_settlements';
    entry.source_id = settlement.id;
    entry.read_only = true;
    entry.entry_type = settlement.kind === 'ca_transfer' ? 'TDS FUNDS TO CA' : 'TDS GOVERNMENT DEPOSIT';
    entry.category = 'TDS SETTLEMENT';
    entry.tds_settlement_id = settlement.id;
    entry.tds_settlement_kind = settlement.kind;
    entry.tds_settlement_amount = settlement.amount;
    entry.challan_no = settlement.challan_no;
    entry.ca_name = settlement.ca_name;
    entry.transaction_id = settlement.transaction_id;
  }
  return entries;
}
