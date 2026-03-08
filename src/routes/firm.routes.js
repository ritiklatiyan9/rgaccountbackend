import express from 'express';
const router = express.Router();

import {
  createFirm, listFirms, getFirm, updateFirm, deleteFirm,
  createTransaction, listTransactions, getTransaction, updateTransaction, deleteTransaction,
  getAutocomplete, listCashFlowLedgersForFirm,
} from '../controllers/firm.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

// All firm routes require auth
router.use(authMiddleware);

// ── Firm endpoints ──
router.get('/list', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), listFirms);                        // ?site_id=X
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getAutocomplete);                     // ?site_id=X
router.get('/cashflow-ledgers', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), listCashFlowLedgersForFirm);     // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getFirm);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), createFirm);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'update'), updateFirm);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), deleteFirm);

// ── Transaction endpoints ──
router.get('/transactions/list', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), listTransactions);               // ?firm_id=X
router.get('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'read'), getTransaction);
router.post('/transactions', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'write'), createTransaction);
router.put('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'update'), updateTransaction);
router.delete('/transactions/:id', requireRole('admin', 'sub_admin'), requirePermission('firm_transactions', 'delete'), deleteTransaction);

export default router;
