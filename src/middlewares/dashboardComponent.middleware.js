import { dashboardComponentAllowed, loadDashboardPermissions } from '../services/dashboardPermissions.service.js';

export const requireDashboardComponent = key => async (req, res, next) => {
  try {
    const permissions = await loadDashboardPermissions(req);
    if (!dashboardComponentAllowed(req.user, permissions, key)) return res.status(403).json({ message: 'Access to this dashboard component is disabled' });
    next();
  } catch (error) { next(error); }
};
