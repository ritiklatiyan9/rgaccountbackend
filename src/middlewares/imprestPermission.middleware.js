import permissionModel from '../models/Permission.model.js';

const FUNDING_MODULES = new Set(['expenses', 'daybook', 'cashflow', 'farmers', 'firm_transactions',
  'commissions', 'vendors', 'plot_payments', 'misc_income', 'sites']);
const FUNDING_MODULE_ALIASES = Object.freeze({ expense: 'expenses', farmer_payment: 'farmers',
  commission_payment: 'commissions', plot_commission: 'commissions', plot_commission_payment: 'commissions', firm_transaction: 'firm_transactions',
  plot_payment: 'plot_payments', vendor_payment: 'vendors', vendor_inventory_payment: 'vendors',
  partner_profit_payment: 'sites', land_deal_payment: 'farmers' });

// A financial writer may check their own funding while entering a payment,
// without receiving access to Imprest ledgers, transfers or other users.
// This middleware belongs only on /balance; site access still runs afterward.
export const requireImprestBalanceAccess = async (req, res, next) => {
  if (req.query.purpose !== 'cash-funding') return requireImprestReadAccess(req, res, next);
  try {
    if (['admin', 'super_admin'].includes(req.user?.role)) return requireImprestReadAccess(req, res, next);
    if (req.user?.role !== 'sub_admin' || req.query.scope === 'management'
      || (req.query.user_id != null && String(req.query.user_id) !== String(req.user.id))) {
      return res.status(403).json({ message: 'Cash funding checks can only show your own balance' });
    }
    const module = FUNDING_MODULE_ALIASES[req.query.module] || req.query.module;
    if (!FUNDING_MODULES.has(module)) return res.status(400).json({ message: 'Choose a valid financial module for this funding check' });
    const permission = await permissionModel.getPermission(req.user.id, module);
    if (permission?.can_write !== true && permission?.can_update !== true) {
      return res.status(403).json({ message: 'You do not have permission to record payments in this module' });
    }
    return next();
  } catch (error) { return next(error); }
};

// Resolve permissions before caching so revoking Management never leaves a
// broader site-wide snapshot available through a personal Imprest grant.
export const requireImprestReadAccess = async (req, res, next) => {
  try {
    const admin = ['admin', 'super_admin'].includes(req.user?.role);
    if (admin) {
      req.canReadPersonalImprest = true;
      req.canManageImprest = true;
    } else if (req.user?.role === 'sub_admin') {
      const [personal, management] = await Promise.all([
        permissionModel.getPermission(req.user.id, 'imprest'),
        permissionModel.getPermission(req.user.id, 'imprest_management'),
      ]);
      req.canReadPersonalImprest = personal?.can_read === true;
      req.canManageImprest = management?.can_read === true;
    }
    if (!req.canReadPersonalImprest && !req.canManageImprest) {
      return res.status(403).json({ message: 'You do not have permission to view Imprest' });
    }
    if (req.query.scope === 'management' && !req.canManageImprest) {
      return res.status(403).json({ message: 'You do not have permission to view Imprest Management' });
    }
    return next();
  } catch (error) { return next(error); }
};

export const hasImprestManagementScope = (req) =>
  req.canManageImprest === true && req.query.scope === 'management';
