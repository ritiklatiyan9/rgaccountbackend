import express from 'express';
const router = express.Router();

import { createSubAdmin, listSubAdmins, updateSubAdmin, deleteSubAdmin } from '../controllers/admin.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All admin routes require authentication + admin role
router.use(authMiddleware, requireRole('admin'));

router.post('/sub-admins', createSubAdmin);
router.get('/sub-admins', listSubAdmins);
router.put('/sub-admins/:id', updateSubAdmin);
router.delete('/sub-admins/:id', deleteSubAdmin);

export default router;
