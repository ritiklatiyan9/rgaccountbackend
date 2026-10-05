import pool from '../config/db.js';
import { TDS_SOURCES } from './paymentTds.service.js';

const tables = new Set([...Object.values(TDS_SOURCES).map(source => source.table), 'plot_commission_payments']);
const prefixes = { expense: 'expenses', fp: 'farmer_payments', comm: 'plot_commissions', cf: 'cash_flow_entries', ft: 'firm_transactions', vp: 'vendor_payments', vip: 'vendor_inventory_payments', pcp: 'plot_commission_payments', ppp: 'partner_profit_payments' };
const fields = ['tds_amount','tds_rate','tds_mode','tds_section','tds_module','tds_member_id','tds_deductee_name','tds_pan','tds_aadhaar'];
function sourceOf(entry) {
  for (const [key, table] of [['expense_id','expenses'],['farmer_payment_id','farmer_payments'],['commission_id','plot_commissions'],['cash_flow_entry_id','cash_flow_entries'],['firm_transaction_id','firm_transactions']]) {
    if (entry[key]) return { table, id: entry[key] };
  }
  if (tables.has(entry.source_key) && entry.source_id) return { table: entry.source_key, id: entry.source_id };
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
    const { rows } = await db.query(`SELECT s.id, ${select} FROM ${table} s ${commission ? 'LEFT JOIN plot_commissions_v2 master ON master.id=s.plot_commission_id' : ''} WHERE s.id=ANY($1::int[])`, [[...ids]]);
    for (const row of rows) snapshots.set(`${table}:${row.id}`, row);
  }));
  for (const entry of entries) {
    const source = sourceOf(entry);
    const snapshot = source && snapshots.get(`${source.table}:${source.id}`);
    if (snapshot) for (const field of fields) entry[field] = snapshot[field];
  }
  return entries;
}
