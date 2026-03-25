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
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const expenseCategoryReadCache = cacheResponse({ ttlSeconds: 60, namespace: 'expense-categories' });
const bustExpenseCategoryCache = invalidateCacheOnSuccess(['/expense-categories']);

router.use(authMiddleware);

router.get('/', expenseCategoryReadCache, listExpenseCategories);
router.post('/', requireRole('admin'), createExpenseCategory);
router.put('/:id', requireRole('admin'), updateExpenseCategory);
router.delete('/:id', requireRole('admin'), deleteExpenseCategory);

export default router;
