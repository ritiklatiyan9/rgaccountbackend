import express from 'express';
const router = express.Router();

import {
  createMember, listMembers, searchMembers, getMemberAutocomplete,
  getMember, updateMember, deleteMember, getMemberTransactions, getMemberFinancialInfo,
} from '../controllers/member.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import upload from '../middlewares/multer.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const memberReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'members' });
const bustMemberCache = invalidateCacheOnSuccess(['/members']);

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
router.get('/search', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, searchMembers);
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMemberAutocomplete);
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, listMembers);

// With file upload for documents
router.post('/', requireRole('admin', 'sub_admin'), memberUpload, requirePermission('clients', 'write'), bustMemberCache, createMember);
router.put('/:id', requireRole('admin', 'sub_admin'), memberUpload, requirePermission('clients', 'update'), bustMemberCache, updateMember);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('clients', 'delete'), bustMemberCache, deleteMember);

// Member transactions
router.get('/:id/transactions', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMemberTransactions);
router.get('/:id/financial-info', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMemberFinancialInfo);

// Dynamic param last
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('clients', 'read'), memberReadCache, getMember);

export default router;
