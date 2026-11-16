import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import upload, { receiveUpload } from '../middlewares/multer.middleware.js';
import {
  listComplaints, getComplaintPeople, getComplaint, createComplaint, changeComplaintStatus,
  reassignComplaint, shareComplaint, getComplaintAttachment, getComplaintAccess, updateComplaintAccess,
  getComplaintInbox, getComplaintComments, createComplaintComment, markComplaintCommentsSeen,
} from '../controllers/complaint.controller.js';

// The service re-checks role, organisation, site assignment and visibility on
// every call; routes only gate who may reach the module at all.
const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/', listComplaints);
router.get('/inbox', getComplaintInbox);
router.get('/people', getComplaintPeople);
// Up to 5 PDFs/photos (already optimized in the browser), 5 MB each.
router.post('/', receiveUpload(upload.array('attachments', 5)), createComplaint);
router.get('/access', requireRole('admin'), getComplaintAccess);
router.put('/access/:userId', requireRole('admin'), updateComplaintAccess);
router.get('/:id', getComplaint);
router.put('/:id/status', changeComplaintStatus);
router.put('/:id/assign', reassignComplaint);
router.put('/:id/share', shareComplaint);
router.get('/:id/comments', getComplaintComments);
router.post('/:id/comments', createComplaintComment);
router.post('/:id/comments/seen', markComplaintCommentsSeen);
router.get('/:id/attachments/:index', getComplaintAttachment);

export default router;
