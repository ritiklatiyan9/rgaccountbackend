import express from 'express';
const router = express.Router();

import {
  createPlot, listPlots, getPlot, updatePlot, deletePlot,
  createPayment, listPayments, getPayment, updatePayment, deletePayment,
  getAutocomplete,
} from '../controllers/plot.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All plot routes require auth
router.use(authMiddleware);

// ── Plot endpoints ──
router.get('/', listPlots);                                        // ?site_id=X
router.get('/autocomplete', getAutocomplete);                      // ?site_id=X
router.get('/:id', getPlot);
router.post('/', requireRole('admin', 'sub_admin'), createPlot);
router.put('/:id', requireRole('admin', 'sub_admin'), updatePlot);
router.delete('/:id', requireRole('admin', 'sub_admin'), deletePlot);

// ── Payment endpoints ──
router.get('/payments/list', listPayments);                        // ?plot_id=X
router.get('/payments/:id', getPayment);
router.post('/payments', requireRole('admin', 'sub_admin'), createPayment);
router.put('/payments/:id', requireRole('admin', 'sub_admin'), updatePayment);
router.delete('/payments/:id', requireRole('admin', 'sub_admin'), deletePayment);

export default router;
