import express from 'express';
const router = express.Router();

import {
  createRegistry, listRegistries, getRegistry, updateRegistry, deleteRegistry,
  createRegistryPayment, listRegistryPayments, getRegistryPayment, updateRegistryPayment, deleteRegistryPayment,
  getRegistryAutocomplete,
} from '../controllers/registry.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const registryReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'registries' });
const bustRegistryCache = invalidateCacheOnSuccess(['/registries']);

// All registry routes require auth
router.use(authMiddleware);

// ── Registry Payment endpoints (BEFORE /:id to avoid route conflict) ──
router.get('/payments/list', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), registryReadCache, listRegistryPayments);                        // ?registry_id=X
router.get('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), registryReadCache, getRegistryPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), bustRegistryCache, createRegistryPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), bustRegistryCache, updateRegistryPayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), bustRegistryCache, deleteRegistryPayment);

// ── Registry endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), registryReadCache, listRegistries);                                           // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), registryReadCache, getRegistryAutocomplete);                      // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), registryReadCache, getRegistry);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), bustRegistryCache, createRegistry);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), bustRegistryCache, updateRegistry);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), bustRegistryCache, deleteRegistry);

export default router;
