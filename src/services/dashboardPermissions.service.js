import pool from '../config/db.js';

export const ALL_COMPONENTS = [
  'financial_overview', 'revenue_charts', 'peak_revenue', 'peak_expenses', 'revenue_comparison', 'profit_trend', 'tds_summary',
  'kpi_totalIncoming', 'kpi_plotPayments', 'kpi_miscIncome', 'kpi_landProfit', 'kpi_registryPayments',
  'kpi_personalLedger', 'kpi_totalExpense', 'kpi_profit', 'kpi_siteBalance', 'cashflow_forecast', 'expense_radar',
  'recent_transactions', 'module_breakdown', 'site_cashflow', 'approvals', 'member_search', 'activity_card',
  'compliance_calendar', 'compliance_watch', 'verify_panel', 'complaints_summary',
];

const analyticsKeys = new Set(['peak_revenue', 'peak_expenses', 'revenue_comparison', 'profit_trend']);
export function dashboardComponentAllowed(user, permissions, key) {
  if (['admin', 'super_admin'].includes(user?.role)) return true;
  if (!user || permissions?.[key] === false) return false;
  if ((key.startsWith('kpi_') || ['tds_summary', 'module_breakdown'].includes(key)) && permissions?.financial_overview === false) return false;
  if (analyticsKeys.has(key) && permissions?.revenue_charts === false) return false;
  // A comparison or a profit value would reveal the other series by subtraction.
  if (['revenue_comparison', 'profit_trend'].includes(key)
    && (permissions?.peak_revenue === false || permissions?.peak_expenses === false)) return false;
  if (key === 'module_breakdown' && permissions?.kpi_totalExpense === false) return false;
  if (key === 'verify_panel' && (permissions?.financial_overview === false
    || ['kpi_siteBalance', 'kpi_plotPayments', 'kpi_totalExpense', 'kpi_profit'].some(name => permissions?.[name] === false))) return false;
  return true;
}

// Only memoize within a request, so a permission change applies to the next read,
// including reads served from the shared financial-report cache.
export function loadDashboardPermissions(ctx) {
  if (['admin', 'super_admin'].includes(ctx.user?.role)) return Promise.resolve({});
  if (!ctx.dashboardPermissionsRead) ctx.dashboardPermissionsRead = pool.query(
    'SELECT component, allowed FROM dashboard_component_permissions WHERE user_id = $1', [ctx.user.id],
  ).then(({ rows }) => Object.fromEntries(rows.map(row => [row.component, row.allowed])));
  return ctx.dashboardPermissionsRead;
}

export const KPI_COMPONENTS = {
  siteBalance: 'kpi_siteBalance', siteBalanceDetail: 'kpi_siteBalance', imprestGiven: 'kpi_siteBalance',
  imprestDistribution: 'kpi_siteBalance', imprestPairs: 'kpi_siteBalance', tds: 'tds_summary',
  plotIncoming: 'kpi_plotPayments', totalRevenue: 'kpi_plotPayments',
  landProfitDetail: 'kpi_landProfit', registryPaymentDetail: 'kpi_registryPayments',
  runningExpense: 'kpi_totalExpense', totalExpense: 'kpi_totalExpense',
  partnerProfitPaid: 'admin_only', expectedProfit: 'kpi_totalIncoming', currentProfit: 'kpi_profit',
  netProfit: 'kpi_profit', profitMargin: 'kpi_profit', currentProfitMargin: 'kpi_profit',
  outstanding: 'kpi_personalLedger', outstandingDetail: 'kpi_personalLedger', personalLedgerCredit: 'kpi_personalLedger',
  cashflow: 'site_cashflow', cashflowDetail: 'site_cashflow', miscIncome: 'kpi_miscIncome', miscIncomeDetail: 'kpi_miscIncome',
  registryPayments: 'kpi_registryPayments', registryPaymentsCount: 'kpi_registryPayments',
  registryPaymentsNew: 'kpi_registryPayments', registryPaymentsOld: 'kpi_registryPayments',
  registryPaymentsNewCount: 'kpi_registryPayments', registryPaymentsOldCount: 'kpi_registryPayments',
  registryRoTotal: 'kpi_registryPayments', registryRoCash: 'kpi_registryPayments', registryRoBank: 'kpi_registryPayments',
  registryRoCount: 'kpi_registryPayments', registryRoDiff: 'kpi_registryPayments', registryRoExact: 'kpi_registryPayments',
  breakdown: 'module_breakdown',
};
export function dashboardKpiFieldAllowed(user, permissions, field) {
  if (['admin', 'super_admin'].includes(user?.role)) return true;
  const key = KPI_COMPONENTS[field.split('.')[0]];
  if (/^siteBalanceDetail\.(tdsPayable|tdsWithCa|tdsReserve|availableBalance)$/.test(field)
    && !dashboardComponentAllowed(user, permissions, 'tds_summary')) return false;
  return key && key !== 'admin_only' && dashboardComponentAllowed(user, permissions, 'financial_overview')
    && dashboardComponentAllowed(user, permissions, key)
    && (field !== 'breakdown' || dashboardComponentAllowed(user, permissions, 'kpi_totalExpense'));
}
