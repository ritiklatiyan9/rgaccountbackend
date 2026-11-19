import express from 'express';
import requireRole from '../middlewares/role.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import { quickTransferContext, createQuickPersonalLedgerTransfer } from '../services/quickPersonalLedgerTransfer.service.js';
import { siteCashReceiptContext, unreadSiteDebits, readSiteDebit } from '../services/siteCashReceipt.service.js';

// Mounted behind the Accounts session in both the API and the local dashboard.
const router = express.Router();
router.use(requireRole('admin', 'sub_admin'));
router.get('/context', asyncHandler(async (req, res) => res.json(await siteCashReceiptContext(req.user, req.query.destination_ledger_id))));
router.get('/funding', asyncHandler(async (req, res) => res.json(await quickTransferContext(req.user, req.query))));
router.post('/', asyncHandler(async (req, res) => {
  const result = await createQuickPersonalLedgerTransfer(req.user, req.body, undefined, { siteReceipt: true });
  res.status(result.replayed ? 200 : 201).json(result);
}));
router.get('/debits', asyncHandler(async (req, res) => res.json(await unreadSiteDebits(req.user, req.query.site_id))));
router.put('/debits/:id/read', asyncHandler(async (req, res) => {
  await readSiteDebit(req.user, req.body.site_id, req.params.id);
  res.sendStatus(204);
}));
export default router;
