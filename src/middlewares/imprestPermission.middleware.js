import permissionModel from '../models/Permission.model.js';

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
