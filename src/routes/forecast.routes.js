import express from 'express';
import {
  getCashflowForecast, listInvestorPayouts, createInvestorPayout,
  updateInvestorPayout, deleteInvestorPayout,
} from '../controllers/forecast.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

const router = express.Router();
router.use(authMiddleware);

// Dashboard-read pattern: role gate only (matches daybook analytics endpoints); data is site-scoped.
router.get('/', requireRole('admin', 'sub_admin'), getCashflowForecast);

// Investor/partner payout schedule — the outflow stream that feeds the forecast.
router.get('/investor-payouts', requireRole('admin', 'sub_admin'), listInvestorPayouts);
router.post('/investor-payouts', requireRole('admin', 'sub_admin'), createInvestorPayout);
router.patch('/investor-payouts/:id', requireRole('admin', 'sub_admin'), updateInvestorPayout);
router.delete('/investor-payouts/:id', requireRole('admin', 'sub_admin'), deleteInvestorPayout);

export default router;
