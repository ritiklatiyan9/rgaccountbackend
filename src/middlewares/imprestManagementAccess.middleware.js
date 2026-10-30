import pool from '../config/db.js';
import { visibleImprestPeople } from '../services/imprestManagementAccess.service.js';

export const loadImprestManagementVisibility = async (req, res, next) => {
  try {
    if (req.user.role === 'sub_admin' && req.canManageImprest === true
      && (req.query.scope === 'management' || ['/all-balances', '/approval-activity'].includes(req.path))) {
      req.imprestVisibleUserIds = await visibleImprestPeople(pool, req.user, req.imprestSiteId);
    }
    next();
  } catch (error) { next(error); }
};

export const managementVisibleUserIds = req => ['admin', 'super_admin'].includes(req.user.role)
  ? null : (req.imprestVisibleUserIds || []);
