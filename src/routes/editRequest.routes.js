import express from 'express';
import {
  createEditRequest,
  listEditRequests,
  listMyEditRequests,
  getEditRequestCounts,
  approveEditRequest,
  rejectEditRequest,
} from '../controllers/editRequest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Sub-admin creates edit request (with optional proof photo)
router.post('/', upload.single('proof_photo'), createEditRequest);

// Sub-admin views own requests
router.get('/my-requests', listMyEditRequests);

// Admin endpoints
router.get('/', requireRole('admin'), listEditRequests);
router.get('/counts', requireRole('admin'), getEditRequestCounts);
router.put('/:id/approve', requireRole('admin'), upload.single('review_photo'), approveEditRequest);
router.put('/:id/reject', requireRole('admin'), rejectEditRequest);

export default router;
