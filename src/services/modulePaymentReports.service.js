import pool from '../config/db.js';
import commissionModel from '../models/PlotCommissionV2.model.js';
import { farmerModel } from '../models/Farmer.model.js';
import { plotRegistryModel } from '../models/PlotRegistry.model.js';
import { expenseModel } from '../models/Expense.model.js';
import { cashFlowMonthModel } from '../models/CashFlow.model.js';
import { readLandSalesReport, readLandProfitReport } from '../controllers/landDeal.controller.js';

const scope = alias => `($2::text IS NULL OR ${alias}.created_by = ANY(string_to_array($2::text, ',')::int[]))`;
const posted = alias => `financial_transaction_posts(CASE WHEN ${alias}.amount < 0 THEN 'credit' ELSE 'debit' END, ${alias}.status, ${alias}.payment_mode, ${alias}.cheque_status)`;
const queryRows = async (db, sql, siteId, creatorId) => (await db.query(sql, [siteId, creatorId])).rows;

// Only these server-owned datasets can be requested; no client SQL or permission names.
export const MODULE_REPORTS = Object.freeze({
  commission: 'commissions', commission_payments: 'commissions', land_commission: 'commissions',
  registry: 'plot_registry', expenses: 'expenses', land_purchase: 'farmers', land_payments: 'farmers',
  land_sale: 'farmers', land_profit: 'farmers', vendor_payments: 'vendors',
  misc_income: 'misc_income', daybook: 'daybook', personal_ledgers: 'cashflow',
});

export async function loadModuleReport(key, siteId, creatorId, db = pool) {
  switch (key) {
    case 'commission': return commissionModel.findBySiteIdGroupedByPlot(siteId, db, null, null, creatorId);
    case 'registry': return plotRegistryModel.findBySiteId(siteId, db, creatorId);
    case 'expenses': return (await expenseModel.findPaginatedUnified(siteId, { created_by: creatorId }, 1, 0, db)).items;
    case 'land_purchase': return farmerModel.findBySiteId(siteId, db, creatorId);
    case 'land_sale': return readLandSalesReport(siteId, creatorId, db);
    case 'land_profit': return readLandProfitReport(siteId, creatorId, db);
    case 'personal_ledgers': return cashFlowMonthModel.findBySiteId(siteId, db, creatorId);
    case 'commission_payments': return queryRows(db, `
      SELECT p.*, pc.total_commission, pc.remarks AS commission_remarks,
             pl.plot_no, pl.buyer_name, m.full_name AS agent_name, m.team, u.name AS created_by_name
      FROM plot_commission_payments p
      JOIN plot_commissions_v2 pc ON pc.id = p.plot_commission_id AND pc.site_id = $1
      JOIN plots pl ON pl.id = pc.plot_id AND pl.site_id = pc.site_id
      LEFT JOIN members m ON m.id = pc.agent_id LEFT JOIN users u ON u.id = p.created_by
      WHERE ${scope('p')} ORDER BY p.date DESC, p.id DESC`, siteId, creatorId);
    case 'land_commission': return queryRows(db, `
      SELECT pc.*, CASE WHEN pc.farmer_id IS NOT NULL THEN 'Land purchase' ELSE 'Land sale' END AS kind,
             COALESCE(f.name, d.buyer_name) AS subject_name, m.full_name AS agent_name, m.phone AS agent_phone, m.team,
             COALESCE(a.total_paid,0) AS total_paid, COALESCE(a.cash_paid,0) AS cash_paid, COALESCE(a.bank_paid,0) AS bank_paid,
             pc.total_commission - COALESCE(a.total_paid,0) AS balance
      FROM plot_commissions_v2 pc
      LEFT JOIN farmers f ON f.id = pc.farmer_id LEFT JOIN land_deals d ON d.id = pc.land_deal_id
      LEFT JOIN members m ON m.id = pc.agent_id
      LEFT JOIN LATERAL (
        SELECT SUM(p.amount + p.tds_amount) AS total_paid,
               SUM(p.amount) FILTER (WHERE ledger_bucket(p.payment_mode) = 'cash') AS cash_paid,
               SUM(p.amount) FILTER (WHERE ledger_bucket(p.payment_mode) <> 'cash') AS bank_paid
        FROM plot_commission_payments p WHERE p.plot_commission_id = pc.id AND ${scope('p')}
          AND ${posted('p')} AND p.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      ) a ON TRUE
      WHERE pc.site_id = $1 AND pc.plot_id IS NULL ORDER BY pc.created_at DESC`, siteId, creatorId);
    case 'land_payments': return queryRows(db, `
      SELECT p.*, f.name AS farmer_name, f.phone, u.name AS created_by_name
      FROM farmer_payments p JOIN farmers f ON f.id = p.farmer_id AND f.site_id = $1
      LEFT JOIN users u ON u.id = p.created_by
      WHERE ${scope('p')} ORDER BY p.date DESC, p.id DESC`, siteId, creatorId);
    case 'vendor_payments': return queryRows(db, `
      SELECT p.*, p.payment_date AS date, c.vendor_name, c.work_title, c.head_name,
             c.contract_amount, u.name AS created_by_name
      FROM vendor_payments p JOIN vendor_commitments c ON c.id = p.commitment_id AND c.site_id = p.site_id
      LEFT JOIN users u ON u.id = p.created_by
      WHERE p.site_id = $1 AND ${scope('p')} ORDER BY p.payment_date DESC, p.id DESC`, siteId, creatorId);
    case 'misc_income': return queryRows(db, `
      SELECT e.*, c.name AS category_name, u.name AS created_by_name, a.name AS assigned_admin_name
      FROM misc_income_entries e JOIN misc_income_categories c ON c.id = e.category_id
      LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users a ON a.id = e.assigned_admin_id
      WHERE e.site_id = $1 AND ${scope('e')} ORDER BY e.date DESC, e.id DESC`, siteId, creatorId);
    case 'daybook': return queryRows(db, `
      SELECT e.*, e.cash_type AS payment_mode, m.ledger_name, u.name AS created_by_name, b.name AS bank_account_name
      FROM cash_flow_entries e LEFT JOIN cash_flow_months m ON m.id = e.cash_flow_month_id
      LEFT JOIN users u ON u.id = e.created_by
      LEFT JOIN bank_accounts b ON b.id = e.bank_account_id AND b.site_id = e.site_id
      WHERE e.site_id = $1 AND COALESCE(m.ledger_type, 'site') = 'site'
        AND (e.source_module IS NULL OR e.source_module !~ '_person$') AND ${scope('e')}
      ORDER BY e.date DESC, e.id DESC`, siteId, creatorId);
    default: throw new Error('Unknown module report.');
  }
}
