import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  getFeatures,
  updatePlotRegistryWorkflow,
} from '../controllers/applicationSetting.controller.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();
const bustRegistryCache = invalidateCacheOnSuccess(['registries|']);

// Every authenticated user may read flags for an assigned site because feature
// consumers (such as Plot Registry) need them. Only admins may change them.
router.get('/features', authMiddleware, getFeatures);
router.put(
  '/features/plot-registry-workflow-unlocked',
  authMiddleware,
  requireRole('admin'),
  bustRegistryCache,
  updatePlotRegistryWorkflow
);

export default router;
