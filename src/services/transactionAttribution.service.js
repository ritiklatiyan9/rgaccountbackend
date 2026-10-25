import pool from '../config/db.js';

const tables = ['plot_payments', 'plot_installment_payments', 'plot_registry_payments', 'farmer_payments',
  'land_deal_payments', 'plot_commission_payments', 'plot_commissions', 'firm_transactions', 'cash_flow_entries',
  'day_book', 'expenses', 'vendor_payments', 'vendor_inventory_payments', 'misc_income_entries',
  'partner_profit_payments', 'tds_settlements'];
const aliases = Object.fromEntries(tables.flatMap(table => [[table, table], [table.replace(/s$/, ''), table]]));
Object.assign(aliases, { plot_payment: 'plot_payments', farmer_payment: 'farmer_payments',
  plot_commission: 'plot_commissions', plot_commission_payment: 'plot_commission_payments',
  registry_payment: 'plot_registry_payments', cashflow_entry: 'cash_flow_entries', personal_ledger: 'cash_flow_entries',
  daybook: 'day_book', expense: 'expenses', vendor_payment: 'vendor_payments', misc_income: 'misc_income_entries' });
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const text = value => typeof value === 'string' && value.trim() && value.trim() !== '—' ? value.trim() : null;

// Enrich only rows already authorized by their module. Batch names per response,
// retaining the financial values and avoiding a query for each transaction.
export async function withTransactionAttribution(payload, actor, database = pool) {
  if (!id(actor?.id)) return payload;
  const rows = [];
  function copy(value) {
    if (!value || typeof value !== 'object' || value instanceof Date || Buffer.isBuffer(value)) return value;
    if (Array.isArray(value)) return value.map(copy);
    const row = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    if ((row.id != null || row.source_id != null) && ['created_by', 'approved_by', 'created_by_name', 'source_key', 'source_table', 'source_module']
      .some(key => Object.hasOwn(row, key))) rows.push(row);
    return row;
  }
  const result = copy(payload);
  const groups = new Map();
  for (const row of rows) {
    const table = aliases[row.source_table || row.source_key || row.source_module || row.source];
    const sourceId = id(row.source_id ?? (row.source ? row.original_id ?? row.id : null));
    if (!table || !sourceId || (text(row.created_by_name) && text(row.approved_by_name))) continue;
    const group = groups.get(table) || new Map();
    const targets = group.get(sourceId) || [];
    targets.push(row); group.set(sourceId, targets); groups.set(table, group);
  }
  for (const [table, group] of groups) {
    let sources;
    try {
      ({ rows: sources } = await database.query(`SELECT t.id,
        to_jsonb(t)->>'created_by' AS created_by, to_jsonb(t)->>'approved_by' AS approved_by,
        to_jsonb(t)->>'site_id' AS site_id
        FROM ${table} t JOIN sites s ON s.id=NULLIF(to_jsonb(t)->>'site_id','')::integer
        WHERE t.id=ANY($1::int[]) AND s.organization_id=(SELECT organization_id FROM users WHERE id=$2)`,
      [[...group.keys()], actor.id]));
    } catch (error) {
      if (error.code === '42P01') continue; // Optional historical source was removed.
      throw error;
    }
    for (const source of sources) for (const row of group.get(Number(source.id)) || []) {
      if (row.site_id != null && Number(row.site_id) !== Number(source.site_id)) continue;
      if (!Object.hasOwn(row, 'created_by') && !text(row.created_by_name)) row.created_by = id(source.created_by);
      if (!Object.hasOwn(row, 'approved_by') && !text(row.approved_by_name)) row.approved_by = id(source.approved_by);
    }
  }
  const ids = [...new Set(rows.flatMap(row => [
    !text(row.created_by_name) ? id(row.created_by) : null,
    !text(row.approved_by_name) ? id(row.approved_by) : null,
  ]).filter(Boolean))];
  if (!ids.length) return result;
  const { rows: users } = await database.query(`SELECT id,name FROM users WHERE id=ANY($1::int[])
    AND organization_id=(SELECT organization_id FROM users WHERE id=$2)`, [ids, actor.id]);
  const names = new Map(users.map(user => [Number(user.id), user.name]));
  for (const row of rows) {
    if (!text(row.created_by_name) && id(row.created_by)) row.created_by_name = names.get(Number(row.created_by)) || null;
    if (!text(row.approved_by_name) && id(row.approved_by)) row.approved_by_name = names.get(Number(row.approved_by)) || null;
  }
  return result;
}
