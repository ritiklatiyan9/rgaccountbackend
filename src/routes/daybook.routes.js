import express from 'express';
import {
  createDayBookEntry,
  listDayBookEntries,
  getDayBookEntry,
  updateDayBookEntry,
  deleteDayBookEntry,
  getAutocomplete,
  updateExpenseFromDayBook,
  deleteExpenseFromDayBook,
  listFarmersForDayBook,
  updateFarmerPaymentFromDayBook,
  deleteFarmerPaymentFromDayBook,
  listMembersForDayBook,
  updateCommissionFromDayBook,
  deleteCommissionFromDayBook,
  listCashFlowLedgersForDayBook,
  updateCashFlowEntryFromDayBook,
  deleteCashFlowEntryFromDayBook,
  listFirmsForDayBook,
  updateFirmTransactionFromDayBook,
  deleteFirmTransactionFromDayBook,
  listPlotsForDayBook,
  updatePlotPaymentFromDayBook,
  deletePlotPaymentFromDayBook,
} from '../controllers/daybook.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Day Book CRUD
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'write'), createDayBookEntry);
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listDayBookEntries);
router.get('/autocomplete', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), getAutocomplete);

// Farmers list for dropdown
router.get('/farmers', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listFarmersForDayBook);

// Expense entries managed from Day Book
router.put('/expense/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updateExpenseFromDayBook);
router.delete('/expense/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), deleteExpenseFromDayBook);

// Farmer payment entries managed from Day Book
router.put('/farmer-payment/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updateFarmerPaymentFromDayBook);
router.delete('/farmer-payment/:id', requirePermission('daybook', 'delete'), deleteFarmerPaymentFromDayBook);

// Members list for dropdown (Plot Commission)
router.get('/members', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listMembersForDayBook);

// Commission entries managed from Day Book
router.put('/commission/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updateCommissionFromDayBook);
router.delete('/commission/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), deleteCommissionFromDayBook);

// Cash Flow ledgers list for dropdown + entries managed from Day Book
router.get('/cashflow-ledgers', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listCashFlowLedgersForDayBook);
router.put('/cashflow-entry/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updateCashFlowEntryFromDayBook);
router.delete('/cashflow-entry/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), deleteCashFlowEntryFromDayBook);

// Firms list for dropdown + firm transactions managed from Day Book
router.get('/firms', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listFirmsForDayBook);
router.put('/firm-transaction/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updateFirmTransactionFromDayBook);
router.delete('/firm-transaction/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), deleteFirmTransactionFromDayBook);

// Plots list for dropdown + plot payments managed from Day Book
router.get('/plots', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), listPlotsForDayBook);
router.put('/plot-payment/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updatePlotPaymentFromDayBook);
router.delete('/plot-payment/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'delete'), deletePlotPaymentFromDayBook);

router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'read'), getDayBookEntry);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('daybook', 'update'), updateDayBookEntry);
router.delete('/:id', requirePermission('daybook', 'delete'), deleteDayBookEntry);

export default router;
