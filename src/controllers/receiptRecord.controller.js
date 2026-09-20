import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { SIGN_TARGETS } from './signature.controller.js';

export const RECEIPT_SOURCES = Object.freeze({
  ...SIGN_TARGETS,
  commission: { table: 'plot_commissions', perm: 'commissions' },
  misc_income_entry: { table: 'misc_income_entries', perm: 'misc_income' },
  plot_installment_payment: { table: 'plot_installment_payments', perm: 'plot_payments', siteQuery: 'SELECT p.site_id FROM plot_installment_payments t JOIN plots p ON p.id=t.plot_id WHERE t.id=$1' },
});
export const requireReceiptPermission = (req, res, next) => {
  const source = Object.hasOwn(RECEIPT_SOURCES, req.params.module) ? RECEIPT_SOURCES[req.params.module] : null;
  if (!source) return res.status(400).json({ message: 'Unknown receipt source' });
  if (source.adminOnly && req.user.role !== 'admin' && req.user.role !== 'super_admin') return res.status(403).json({ message: 'Admin access required' });
  return requirePermission(source.perm, 'read')(req, res, next);
};

// All screens read the native transaction, so summary columns cannot change a receipt.
export const getReceiptRecord = asyncHandler(async (req, res) => {
  const source = Object.hasOwn(RECEIPT_SOURCES, req.params.module) ? RECEIPT_SOURCES[req.params.module] : null;
  const id = Number(req.params.id);
  if (!source || !Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid receipt record' });
  const siteResult = await pool.query(source.siteQuery || `SELECT site_id FROM ${source.table} WHERE id=$1`, [id]);
  const siteId = siteResult.rows[0]?.site_id;
  if (!siteId) return res.status(404).json({ message: 'Receipt record not found' });
  if (!['admin','super_admin'].includes(req.user.role)) {
    const access = await pool.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2', [req.user.id, siteId]);
    if (!access.rowCount) return res.status(403).json({ message: 'Access denied to this site' });
  }
  const [recordResult, site] = await Promise.all([
    pool.query(`SELECT * FROM ${source.table} WHERE id=$1`, [id]),
    pool.query('SELECT id, name, address, city, state FROM sites WHERE id=$1', [siteId]),
  ]);
  const record = recordResult.rows[0];
  if (!record) return res.status(404).json({ message: 'Receipt record not found' });
  const related = async (table, relatedId) => relatedId ? (await pool.query(`SELECT to_jsonb(t) AS data FROM ${table} t WHERE id=$1`, [relatedId])).rows[0]?.data || {} : {};
  let plotId = record.plot_id;
  if (record.plot_commission_id) {
    const commission = await related('plot_commissions_v2', record.plot_commission_id);
    plotId ||= commission.plot_id;
    const agent = await related('members', commission.agent_id);
    record.agent_name = agent.full_name || agent.name || '';
  }
  const plot = await related('plots', plotId);
  if (plot.id) Object.assign(record, { plot_no: plot.plot_no, plot_size: plot.plot_size, plot_rate: plot.plot_rate, buyer_name: record.buyer_name || plot.buyer_name, buyer_phone: plot.buyer_phone });
  for (const [key, table, target] of [['farmer_id','farmers','farmer_name'], ['firm_id','firms','firm_name'], ['member_id','members','party_name']]) {
    if (!record[key]) continue;
    const person = await related(table, record[key]);
    record[target] = person.full_name || person.name || '';
  }
  if (record.commitment_id && req.params.module === 'vendor_payment') {
    const commitment = await related('vendor_commitments', record.commitment_id);
    Object.assign(record, { vendor_name: commitment.vendor_name, work_title: commitment.work_title, head_name: commitment.head_name });
  }
  if (record.order_id && req.params.module === 'vendor_inventory_payment') {
    const order = await related('vendor_inventory_orders', record.order_id);
    Object.assign(record, { vendor_name: order.vendor_name, work_title: order.item_name, head_name: order.item_category });
  }
  if (record.land_deal_id || record.deal_id) {
    const deal = await related('land_deals', record.land_deal_id || record.deal_id);
    Object.assign(record, { land_deal_no: deal.deal_no, buyer_name: deal.buyer_name });
  }
  const link = await pool.query(`SELECT m.full_name FROM transaction_party_links l JOIN members m ON m.id=l.member_id
    WHERE l.site_id=$1 AND l.source_key=$2 AND l.source_id=$3 LIMIT 1`, [siteId, req.params.module, id]);
  record.related_party = link.rows[0]?.full_name || '';
  if (record.assigned_admin_id) {
    const { rows } = await pool.query('SELECT name FROM users WHERE id=$1', [record.assigned_admin_id]);
    record.assigned_to = rows[0]?.name || '';
  }
  if (req.params.module === 'misc_income_entry' && record.category_id) record.category = (await related('misc_income_categories', record.category_id)).name;
  // Plot fields used by the receipt are explicit; never return member KYC or private user records.
  const plotFields = ['id','plot_no','plot_size','plot_rate','buyer_name','booking_by','unit_type','unit_details','project_type'];
  res.set('Cache-Control', 'no-store');
  res.json({ record, site: site.rows[0], plot: Object.fromEntries(plotFields.filter(key => plot[key] != null).map(key => [key, plot[key]])) });
});
