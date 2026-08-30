import express from 'express';
import { getBalanceSheet } from '../controllers/balanceSheet.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);
router.get(
  '/',
  requireRole('admin', 'sub_admin'),
  requirePermission('balance_sheet', 'read'),
  // Avoid retaining multi-megabyte full-history payloads in the in-process
  // cache. Small/date-filtered statements still benefit from the 30s cache.
  cacheResponse({
    ttlSeconds: 30,
    namespace: 'balance-sheet',
    shouldCache: (payload) => (payload?.transactions?.length || 0) <= 1000,
  }),
  getBalanceSheet,
);

export default router;
