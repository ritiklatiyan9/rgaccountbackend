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

const router = express.Router();

// All routes require authentication
router.use(authMiddleware);

// Day Book CRUD
router.post('/', createDayBookEntry);
router.get('/', listDayBookEntries);
router.get('/autocomplete', getAutocomplete);

// Farmers list for dropdown
router.get('/farmers', listFarmersForDayBook);

// Expense entries managed from Day Book
router.put('/expense/:id', updateExpenseFromDayBook);
router.delete('/expense/:id', deleteExpenseFromDayBook);

// Farmer payment entries managed from Day Book
router.put('/farmer-payment/:id', updateFarmerPaymentFromDayBook);
router.delete('/farmer-payment/:id', deleteFarmerPaymentFromDayBook);

// Members list for dropdown (Plot Commission)
router.get('/members', listMembersForDayBook);

// Commission entries managed from Day Book
router.put('/commission/:id', updateCommissionFromDayBook);
router.delete('/commission/:id', deleteCommissionFromDayBook);

// Cash Flow ledgers list for dropdown + entries managed from Day Book
router.get('/cashflow-ledgers', listCashFlowLedgersForDayBook);
router.put('/cashflow-entry/:id', updateCashFlowEntryFromDayBook);
router.delete('/cashflow-entry/:id', deleteCashFlowEntryFromDayBook);

// Firms list for dropdown + firm transactions managed from Day Book
router.get('/firms', listFirmsForDayBook);
router.put('/firm-transaction/:id', updateFirmTransactionFromDayBook);
router.delete('/firm-transaction/:id', deleteFirmTransactionFromDayBook);

// Plots list for dropdown + plot payments managed from Day Book
router.get('/plots', listPlotsForDayBook);
router.put('/plot-payment/:id', updatePlotPaymentFromDayBook);
router.delete('/plot-payment/:id', deletePlotPaymentFromDayBook);

router.get('/:id', getDayBookEntry);
router.put('/:id', updateDayBookEntry);
router.delete('/:id', deleteDayBookEntry);

export default router;
