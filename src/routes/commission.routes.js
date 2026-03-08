import express from 'express';
const router = express.Router();

import {
  createCommission,
  listCommissions,
  getAutocomplete,
  getCommission,
  updateCommission,
  deleteCommission,
} from '../controllers/commission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

// All commission routes require auth
router.use(authMiddleware);
// Commission CRUD
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), listCommissions);                           // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), getAutocomplete);               // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'read'), getCommission);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'write'), createCommission);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'update'), updateCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('commissions', 'delete'), deleteCommission);

export default router;
