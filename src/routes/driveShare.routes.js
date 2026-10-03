import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { attachOrgContext } from '../utils/complianceAccess.js';
import {
  previewPlotCommissionShare,
  createPlotCommissionShare,
  listPlotCommissionShares,
  getShare,
} from '../controllers/driveShare.controller.js';
import { listDriveShareModules, previewModuleShare, createModuleShare, listModuleShares } from '../controllers/moduleDriveShare.controller.js';

const router = express.Router();

// Each module resolves its own read permission and site/entry visibility.
router.use(authMiddleware, attachOrgContext, requireRole('admin', 'sub_admin'));

router.get('/modules/catalog', listDriveShareModules);
router.get('/modules/:moduleKey/preview', previewModuleShare);
router.get('/modules/:moduleKey/history', listModuleShares);
router.post('/modules/:moduleKey', createModuleShare);
router.get('/plot-commission/preview', requirePermission('commissions', 'read'), previewPlotCommissionShare);
router.post('/plot-commission', requirePermission('commissions', 'read'), createPlotCommissionShare);
router.get('/plot-commission/:plotId', requirePermission('commissions', 'read'), listPlotCommissionShares);
// Progress of one queued/running share; the controller re-checks the share's site.
router.get('/:id', getShare);

export default router;
