import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import {
  listCategories, createCategory, updateCategory, deleteCategory,
  listEntries, createEntry, updateEntry, deleteEntry,
} from '../controllers/miscIncome.controller.js';

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

const readCache = cacheResponse({ ttlSeconds: 30, namespace: 'misc-income' });
// Entries post to the ledger, so writes also clear the Day Book and Balance Sheet caches.
const bustCache = invalidateCacheOnSuccess(['misc-income|', '/daybook']);

const canRead = requirePermission('misc_income', 'read');
const canWrite = requirePermission('misc_income', 'write');
const canUpdate = requirePermission('misc_income', 'update');
const canDelete = requirePermission('misc_income', 'delete');

// Categories are user-managed: anyone who can write entries can add one.
router.get('/categories', canRead, readCache, listCategories);
router.post('/categories', canWrite, bustCache, createCategory);
router.put('/categories/:id', canUpdate, bustCache, updateCategory);
router.delete('/categories/:id', canDelete, bustCache, deleteCategory);

router.get('/', canRead, readCache, listEntries);
router.post('/', canWrite, bustCache, createEntry);
router.put('/:id', canUpdate, bustCache, updateEntry);
router.delete('/:id', canDelete, bustCache, deleteEntry);

export default router;
