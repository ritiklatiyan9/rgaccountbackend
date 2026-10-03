import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { attachOrgContext } from '../utils/complianceAccess.js';
import {
  previewPlotCommissionShare,
  createPlotCommissionShare,
  listPlotCommissionShares,
} from '../controllers/driveShare.controller.js';

const router = express.Router();

// Sharing is a read of commission data into the org's own Drive, so the
// 'commissions' read permission gates every route; the controller further
// limits sub-admins without can_view_all to single-transaction shares.
router.use(authMiddleware, attachOrgContext, requireRole('admin', 'sub_admin'));

router.get('/plot-commission/preview', requirePermission('commissions', 'read'), previewPlotCommissionShare);
router.post('/plot-commission', requirePermission('commissions', 'read'), createPlotCommissionShare);
router.get('/plot-commission/:plotId', requirePermission('commissions', 'read'), listPlotCommissionShares);

export default router;
