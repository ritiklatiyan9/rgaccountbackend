import express from 'express';
const router = express.Router();

import {
  createRegistry, listRegistries, getRegistry, updateRegistry, deleteRegistry,
  createRegistryPayment, listRegistryPayments, getRegistryPayment, updateRegistryPayment, deleteRegistryPayment,
  getRegistryAutocomplete,
} from '../controllers/registry.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All registry routes require auth
router.use(authMiddleware);

// ── Registry Payment endpoints (BEFORE /:id to avoid route conflict) ──
router.get('/payments/list', listRegistryPayments);                        // ?registry_id=X
router.get('/payments/:id', getRegistryPayment);
router.post('/payments', requireRole('admin'), createRegistryPayment);
router.put('/payments/:id', requireRole('admin'), updateRegistryPayment);
router.delete('/payments/:id', requireRole('admin'), deleteRegistryPayment);

// ── Registry endpoints ──
router.get('/', listRegistries);                                           // ?site_id=X
router.get('/autocomplete', getRegistryAutocomplete);                      // ?site_id=X
router.get('/:id', getRegistry);
router.post('/', requireRole('admin'), createRegistry);
router.put('/:id', requireRole('admin'), updateRegistry);
router.delete('/:id', requireRole('admin'), deleteRegistry);

export default router;
