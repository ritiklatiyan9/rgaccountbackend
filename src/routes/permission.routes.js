import express from 'express';
const router = express.Router();

import { getPermissions, updatePermissions } from '../controllers/permission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All permission routes require authentication + admin role
router.use(authMiddleware, requireRole('admin'));

router.get('/:userId', getPermissions);
router.put('/:userId', updatePermissions);

export default router;
