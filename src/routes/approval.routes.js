import express from 'express';
const router = express.Router();

import {
  listAllPending,
  getPendingCounts,
  approveEntry,
  rejectEntry,
  bulkApprove,
  bulkReject,
} from '../controllers/approval.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All approval routes require auth + admin role
router.use(authMiddleware);
router.use(requireRole('admin'));

router.get('/pending', listAllPending);           // ?site_id=X&date_from=&date_to=&module=
router.get('/counts', getPendingCounts);           // ?site_id=X
router.put('/:id/approve', approveEntry);          // ?source=farmer_payment|plot_commission|...
router.put('/:id/reject', rejectEntry);            // ?source=...
router.post('/bulk-approve', bulkApprove);         // { items: [{ id, source }] }
router.post('/bulk-reject', bulkReject);           // { items: [{ id, source }] }

export default router;
