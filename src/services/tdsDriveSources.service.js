import { attachTransactionParticulars } from './transactionParticulars.service.js';

const KEYS = { cash_flow_entries: 'personal_ledger' };
const MODULE_KEYS = { daybook: 'day_book', expense: 'expenses', imprest_expense: 'expenses', farmer_payment: 'farmer_payments', cashflow: 'personal_ledger',
  firm_transaction: 'firm_transactions', plot_commission: 'plot_commissions', land_purchase_commission: 'plot_commission_payments', land_sale_commission: 'plot_commission_payments',
  vendor_payment: 'vendor_payments', vendor_inventory_payment: 'vendor_inventory_payments', misc_income: 'misc_income_entries', partner_profit_payment: 'partner_profit_payments' };
const PERMISSIONS = { farmer_payment: 'farmers', expense: 'expenses', daybook: 'daybook', cashflow: 'cashflow', firm_transaction: 'firm_transactions',
  vendor_payment: 'vendors', vendor_inventory_payment: 'vendors', misc_income: 'misc_income', partner_profit_payment: 'plot_commission', imprest_expense: 'imprest' };
export const tdsDriveSourceOf = row => ({ source_key: row.commission_payment_id ? 'plot_commission_payments' : KEYS[row.source_table] || row.source_table || MODULE_KEYS[row.source_module],
  source_id: Number(row.commission_payment_id || row.source_id) });

// The register can be read without native-payment permissions. Match its UI:
// source details and evidence require both Day Book and source-module read
// access, and creator visibility is applied before enriching any identity.
export async function enrichTdsDriveSources(rows, { siteId, user }, db) {
  if (!rows.length) return rows;
  const admin = ['admin', 'super_admin'].includes(user.role);
  let creatorId = null;
  let permissions;
  if (!admin) {
    const modules = [...new Set(['daybook', ...rows.map(row => PERMISSIONS[row.source_module] || 'commissions')])];
    const result = await db.query('SELECT module,can_read,can_view_all FROM user_permissions WHERE user_id=$1 AND module=ANY($2::text[])', [user.id, modules]);
    permissions = new Map(result.rows.map(row => [row.module, row]));
    if (permissions.get('daybook')?.can_read !== true) return rows;
    if (permissions.get('daybook')?.can_view_all !== true) creatorId = Number(user.id);
  }
  const targets = rows.filter(row => admin || permissions.get(PERMISSIONS[row.source_module] || 'commissions')?.can_read === true)
    .map(row => ({ row, ...tdsDriveSourceOf(row) })).filter(target => target.source_key && Number.isSafeInteger(target.source_id) && target.source_id > 0);
  if (!targets.length) return rows;
  const identities = [...new Map(targets.map(({ source_key, source_id }) => [`${source_key}:${source_id}`, { source_key, source_id }])).values()];
  const { rows: sources } = await db.query(`SELECT wanted.source_key,wanted.source_id,c.particular,c.remarks,c.voucher_url,
      b.name AS bank_account_name
    FROM jsonb_to_recordset($2::jsonb) AS wanted(source_key text,source_id int)
    JOIN cash_flow_entries c ON c.site_id=$1 AND COALESCE(c.source_module,'personal_ledger')=wanted.source_key
      AND COALESCE(c.source_id,c.id)=wanted.source_id
    LEFT JOIN bank_accounts b ON b.id=c.bank_account_id AND b.site_id=c.site_id
    WHERE ($3::int IS NULL OR c.created_by=$3) ORDER BY c.id`, [siteId, JSON.stringify(identities), creatorId]);
  await attachTransactionParticulars(sources, db);
  const bySource = new Map(sources.map(row => [`${row.source_key}:${row.source_id}`, row]));
  const permittedRows = new Set(targets.map(target => target.row));
  return rows.map(row => {
    if (!permittedRows.has(row)) return row;
    const { source_key, source_id } = tdsDriveSourceOf(row);
    const context = bySource.get(`${source_key}:${source_id}`);
    return context ? { ...row, source_context: context, voucher_url: context.voucher_url, receipt_source_key: source_key, receipt_source_id: source_id } : row;
  });
}
