import express from 'express';
const router = express.Router();

import {
    listCategories, createCategory, updateCategory, deleteCategory,
} from '../controllers/memberCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

router.use(authMiddleware);

// All authenticated users can list categories
router.get('/', requireRole('admin', 'sub_admin'), listCategories);

// Only admin can manage categories
router.post('/', requireRole('admin'), createCategory);
router.put('/:id', requireRole('admin'), updateCategory);
router.delete('/:id', requireRole('admin'), deleteCategory);

export default router;
