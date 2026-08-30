import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import {
  getRecycleBinBatch,
  listRecycleBin,
  purgeRecycleBinBatch,
  restoreRecycleBinBatch,
} from '../controllers/recycleBin.controller.js';

const router = express.Router();
const bustRecoveredDataCaches = invalidateCacheOnSuccess([
  'dashboard|', 'dash-', 'expenses|', 'daybook|', 'cashflow|', 'commissions|',
  'plot-commissions|', 'plots|', 'registries|', 'vendors|', 'farmers|', 'firms|',
  'members|', 'documents|', 'construction|', 'inventory|', 'imprest|', 'excel|',
  'reports|', 'management-analytics|', 'misc-income|', 'bank-reconciliation|',
]);

router.use(authMiddleware);
router.get('/', requirePermission('recycle_bin', 'read'), listRecycleBin);
router.get('/:batchId', requirePermission('recycle_bin', 'read'), getRecycleBinBatch);
router.post('/:batchId/restore', requirePermission('recycle_bin', 'restore'), bustRecoveredDataCaches, restoreRecycleBinBatch);
router.delete('/:batchId', requirePermission('recycle_bin', 'delete'), bustRecoveredDataCaches, purgeRecycleBinBatch);

export default router;
