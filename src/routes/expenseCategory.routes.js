import express from 'express';
const router = express.Router();

import {
    listExpenseCategories,
    createExpenseCategory,
    updateExpenseCategory,
    deleteExpenseCategory,
    listExpenseSubCategories,
    createExpenseSubCategory,
    updateExpenseSubCategory,
    deleteExpenseSubCategory,
} from '../controllers/expenseCategory.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const expenseCategoryReadCache = cacheResponse({ ttlSeconds: 300, namespace: 'expense-categories' });
const bustExpenseCategoryCache = invalidateCacheOnSuccess(['expense-categories|']);

router.use(authMiddleware);

router.get('/', requirePermission('expenses', 'read'), expenseCategoryReadCache, listExpenseCategories);
router.post('/', requireRole('admin'), bustExpenseCategoryCache, createExpenseCategory);
// Sub-categories — declared before '/:id' so 'sub-categories' is never read as an id.
router.get('/sub-categories', requirePermission('expenses', 'read'), expenseCategoryReadCache, listExpenseSubCategories);
router.post('/sub-categories', requireRole('admin'), bustExpenseCategoryCache, createExpenseSubCategory);
router.put('/sub-categories/:id', requireRole('admin'), bustExpenseCategoryCache, updateExpenseSubCategory);
router.delete('/sub-categories/:id', requireRole('admin'), bustExpenseCategoryCache, deleteExpenseSubCategory);
router.put('/:id', requireRole('admin'), bustExpenseCategoryCache, updateExpenseCategory);
router.delete('/:id', requireRole('admin'), bustExpenseCategoryCache, deleteExpenseCategory);

export default router;
