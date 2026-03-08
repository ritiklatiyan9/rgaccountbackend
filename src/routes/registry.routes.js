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

// All registry routes require auth
router.use(authMiddleware);

// ── Registry Payment endpoints (BEFORE /:id to avoid route conflict) ──
router.get('/payments/list', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), listRegistryPayments);                        // ?registry_id=X
router.get('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), getRegistryPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), createRegistryPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), updateRegistryPayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), deleteRegistryPayment);

// ── Registry endpoints ──
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), listRegistries);                                           // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), getRegistryAutocomplete);                      // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), getRegistry);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), createRegistry);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), updateRegistry);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), deleteRegistry);

export default router;
