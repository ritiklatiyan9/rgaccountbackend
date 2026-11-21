import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import { emitToUser } from '../config/socket.js';
import { transferContext, transferInbox, createTransfer, approveTransfer, closeTransfer } from '../services/siteMoneyTransfer.service.js';

// Requester and approver both see a change at once; the bell's poll covers a socket that is down.
const push = transfer => [transfer.requested_by, transfer.approver_id]
  .forEach(id => emitToUser(id, 'site_transfer:changed', { id: transfer.id, status: transfer.status }));
const send = (res, transfer, status = 200) => { push(transfer); res.status(status).json({ transfer }); };

export function createSiteMoneyTransferRouter({ authenticate = authMiddleware } = {}) {
  const router = express.Router();
  router.use(authenticate, requireRole('admin', 'sub_admin'), (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/context', asyncHandler(async (req, res) => res.json(await transferContext(req.user, req.query.site_id))));
  router.get('/inbox', asyncHandler(async (req, res) => res.json(await transferInbox(req.user))));
  router.post('/', requirePermission('daybook', 'write'), asyncHandler(async (req, res) => send(res, await createTransfer(req.user, req.body), 201)));
  router.put('/:id/approve', asyncHandler(async (req, res) => send(res, await approveTransfer(req.user, req.params.id))));
  router.put('/:id/reject', asyncHandler(async (req, res) => send(res, await closeTransfer(req.user, req.params.id, 'reject', req.body?.note))));
  router.put('/:id/cancel', asyncHandler(async (req, res) => send(res, await closeTransfer(req.user, req.params.id, 'cancel'))));
  return router;
}

export default createSiteMoneyTransferRouter();
