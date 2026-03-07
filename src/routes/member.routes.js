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

// Static routes first
router.get('/search', searchMembers);
router.get('/autocomplete', getMemberAutocomplete);
router.get('/', listMembers);

// With file upload for photo
router.post('/', requireRole('admin'), upload.single('photo'), createMember);
router.put('/:id', requireRole('admin'), upload.single('photo'), updateMember);
router.delete('/:id', requireRole('admin'), deleteMember);

// Dynamic param last
router.get('/:id', getMember);

export default router;
