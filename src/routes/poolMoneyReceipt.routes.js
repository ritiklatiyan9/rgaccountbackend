import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import { approvePoolMoneyReceipt } from '../services/poolMoneyReceipt.service.js';
import { allocatePoolReceipt, returnPoolReceipt } from '../services/poolMoney.service.js';
import { accountWhatsAppHooks } from '../services/accountWhatsAppHooks.service.js';

export function createPoolMoneyReceiptRouter({ authenticate = authMiddleware, database = pool } = {}) {
  const router = express.Router();
  router.post('/pool-money/receipts/:id/approve', authenticate, requireRole('admin'),
    requirePermission('plot_payments', 'update'),
    invalidateCacheOnSuccess(['plots|', 'approvals|', '/approvals', '/daybook', 'cashflow|', 'wallet|']),
    asyncHandler(async (req, res) => {
      const result = await approvePoolMoneyReceipt(database, req.user,
        { receiptId: req.params.id, siteId: req.body.site_id, expectedAmount: req.body.expected_amount });
      await accountWhatsAppHooks.paymentApproved('pool_money_receipt', result.receipt);
      return res.json(result);
    }));
  const invalidate = invalidateCacheOnSuccess(['plots|', 'plots:pageData:', 'approvals|', '/approvals', '/daybook', 'daybook|', 'cashflow|', 'wallet|', 'loyalty-vault|', 'banks|', 'registries|', 'registries-meta|']);
  router.post('/pool-money/receipts/:id/allocate', authenticate, requireRole('admin', 'sub_admin'),
    requirePermission('plot_payments', 'write'), invalidate,
    asyncHandler(async (req, res) => {
      const { site_id: siteId, plot_id: plotId, expected_amount: expectedAmount } = req.body ?? {};
      const result = await allocatePoolReceipt(database, req.user, { receiptId: req.params.id, siteId, plotId, expectedAmount });
      return res.status(201).json(result);
    }));
  router.delete('/pool-money/receipts/:id/allocate', authenticate, requireRole('admin'),
    requirePermission('plot_payments', 'delete'), invalidate,
    asyncHandler(async (req, res) => {
      const { site_id: siteId, plot_payment_id: plotPaymentId } = req.body ?? {};
      const result = await returnPoolReceipt(database, req.user, { receiptId: req.params.id, siteId, plotPaymentId });
      return res.json(result);
    }));
  return router;
}
