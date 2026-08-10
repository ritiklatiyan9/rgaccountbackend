import express from 'express';
import {
  listBankAccounts,
  createBankAccount,
  updateBankAccount,
  deleteBankAccount,
  mapEntryToBank,
  getEntryBankMapping,
  listBankEntries,
  listUnmappedEntries,
} from '../controllers/bank.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

// Mapping changes what the Day Book and Balance Sheet display for a row.
const bustBankCache = invalidateCacheOnSuccess(['/daybook', '/balance-sheet', '/banks']);

// Reading the bank list and mapping an entry happen from EVERY money module's
// add/edit modal (expenses, plot payments, personal ledger, commissions…), so
// they are gated by role only — a sub-admin editing an expense may hold no
// daybook permission at all. Bank CRUD stays under the Day Book module.
router.get('/', listBankAccounts);
router.get('/map', getEntryBankMapping);
router.put('/map', bustBankCache, mapEntryToBank);
router.post('/', requirePermission('daybook', 'write'), bustBankCache, createBankAccount);
router.get('/unmapped/entries', requirePermission('daybook', 'read'), listUnmappedEntries);
router.get('/:id/entries', requirePermission('daybook', 'read'), listBankEntries);
router.put('/:id', requirePermission('daybook', 'update'), bustBankCache, updateBankAccount);
router.delete('/:id', requirePermission('daybook', 'delete'), bustBankCache, deleteBankAccount);

export default router;
