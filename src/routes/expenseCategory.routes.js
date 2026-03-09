import express from 'express';
const router = express.Router();

import {
    listExpenseCategories,
    createExpenseCategory,
    updateExpenseCategory,
    deleteExpenseCategory,
} from '../controllers/expenseCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

router.use(authMiddleware);

router.get('/', listExpenseCategories);
router.post('/', requireRole('admin'), createExpenseCategory);
router.put('/:id', requireRole('admin'), updateExpenseCategory);
router.delete('/:id', requireRole('admin'), deleteExpenseCategory);

export default router;
