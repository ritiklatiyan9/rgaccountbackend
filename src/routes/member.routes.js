import express from 'express';
const router = express.Router();

import {
  createMember, listMembers, searchMembers, getMemberAutocomplete,
  getMember, updateMember, deleteMember,
} from '../controllers/member.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import upload from '../middlewares/multer.middleware.js';

router.use(authMiddleware);

// Multi-file upload config for member documents
const memberUpload = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'aadhar_front_url', maxCount: 1 },
  { name: 'aadhar_back_url', maxCount: 1 },
  { name: 'pan_card_url', maxCount: 1 },
  { name: 'voter_id_url', maxCount: 1 },
  { name: 'passport_url', maxCount: 1 },
  { name: 'driving_license_url', maxCount: 1 },
  { name: 'cheque_url', maxCount: 1 },
  { name: 'other_kyc_url', maxCount: 1 },
  { name: 'resume_url', maxCount: 1 },
  { name: 'marksheet_10th_url', maxCount: 1 },
  { name: 'marksheet_12th_url', maxCount: 1 },
  { name: 'degree_certificate_url', maxCount: 1 },
  { name: 'experience_certificate_url', maxCount: 1 },
  { name: 'offer_letter_url', maxCount: 1 },
  { name: 'other_certificate_url', maxCount: 1 },
]);

// Static routes first
router.get('/search', searchMembers);
router.get('/autocomplete', getMemberAutocomplete);
router.get('/', listMembers);

// With file upload for documents
router.post('/', requireRole('admin', 'sub_admin'), memberUpload, createMember);
router.put('/:id', requireRole('admin', 'sub_admin'), memberUpload, updateMember);
router.delete('/:id', requireRole('admin', 'sub_admin'), deleteMember);

// Dynamic param last
router.get('/:id', getMember);

export default router;
