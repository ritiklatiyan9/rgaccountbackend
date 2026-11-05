import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import { approvePoolMoneyReceipt } from '../services/poolMoneyReceipt.service.js';

export function createPoolMoneyReceiptRouter({ authenticate = authMiddleware, database = pool } = {}) {
  const router = express.Router();
  router.post('/pool-money/receipts/:id/approve', authenticate, requireRole('admin'),
    requirePermission('plot_payments', 'update'),
    invalidateCacheOnSuccess(['plots|', 'approvals|', '/approvals', '/daybook', 'cashflow|', 'wallet|']),
    asyncHandler(async (req, res) => res.json(await approvePoolMoneyReceipt(database, req.user,
      { receiptId: req.params.id, siteId: req.body.site_id, expectedAmount: req.body.expected_amount }))));
  return router;
}
