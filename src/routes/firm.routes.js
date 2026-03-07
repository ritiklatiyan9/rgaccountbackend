import express from 'express';
const router = express.Router();

import {
  createFirm, listFirms, getFirm, updateFirm, deleteFirm,
  createTransaction, listTransactions, getTransaction, updateTransaction, deleteTransaction,
  getAutocomplete, listCashFlowLedgersForFirm,
} from '../controllers/firm.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All firm routes require auth
router.use(authMiddleware);

// ── Firm endpoints ──
router.get('/', listFirms);                                       // ?site_id=X
router.get('/autocomplete', getAutocomplete);                     // ?site_id=X
router.get('/cashflow-ledgers', listCashFlowLedgersForFirm);     // ?site_id=X
router.get('/:id', getFirm);
router.post('/', requireRole('admin'), createFirm);
router.put('/:id', requireRole('admin'), updateFirm);
router.delete('/:id', requireRole('admin'), deleteFirm);

// ── Transaction endpoints ──
router.get('/transactions/list', listTransactions);               // ?firm_id=X
router.get('/transactions/:id', getTransaction);
router.post('/transactions', requireRole('admin'), createTransaction);
router.put('/transactions/:id', requireRole('admin'), updateTransaction);
router.delete('/transactions/:id', requireRole('admin'), deleteTransaction);

export default router;
