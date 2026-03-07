import express from 'express';
const router = express.Router();

import {
  createMonth, listMonths, getMonth, updateMonth, deleteMonth,
  createEntry, listEntries, getAutocomplete, getEntry, updateEntry, deleteEntry,
} from '../controllers/cashflow.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All cashflow routes require auth
router.use(authMiddleware);

// ── Month endpoints ──
router.get('/months', listMonths);                                // ?site_id=X
router.get('/months/:id', getMonth);
router.post('/months', requireRole('admin'), createMonth);
router.put('/months/:id', requireRole('admin'), updateMonth);
router.delete('/months/:id', requireRole('admin'), deleteMonth);

// ── Entry endpoints ──
router.get('/entries', listEntries);                              // ?month_id=X
router.get('/entries/:id', getEntry);
router.post('/entries', requireRole('admin'), createEntry);
router.put('/entries/:id', requireRole('admin'), updateEntry);
router.delete('/entries/:id', requireRole('admin'), deleteEntry);

// ── Autocomplete ──
router.get('/autocomplete', getAutocomplete);                     // ?site_id=X

export default router;
