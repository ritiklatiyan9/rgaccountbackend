import express from 'express';
const router = express.Router();

import {
  createMonth, listMonths, getMonth, updateMonth, deleteMonth,
  createEntry, listEntries, getAutocomplete, getEntry, updateEntry, deleteEntry, listFirmsForCashFlow,
} from '../controllers/cashflow.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

// All cashflow routes require auth
router.use(authMiddleware);

// ── Month endpoints ──
router.get('/months', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), listMonths);                                // ?site_id=X
router.get('/months/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), getMonth);
router.post('/months', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'write'), createMonth);
router.put('/months/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'update'), updateMonth);
router.delete('/months/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'delete'), deleteMonth);

// ── Entry endpoints ──
router.get('/entries', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), listEntries);                              // ?month_id=X
router.get('/entries/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), getEntry);
router.post('/entries', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'write'), createEntry);
router.put('/entries/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'update'), updateEntry);
router.delete('/entries/:id', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'delete'), deleteEntry);

// ── Autocomplete ──
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), getAutocomplete);                     // ?site_id=X
router.get('/firms', requireRole('admin', 'sub_admin'), requirePermission('cashflow', 'read'), listFirmsForCashFlow);                      // ?site_id=X

export default router;
