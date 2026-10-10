import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission, { requireAnyPermission } from '../middlewares/permission.middleware.js';
import {
  listDeductions, createDeduction, updateDeduction, deleteDeduction, recordDeposit, listDeductees,
  getAccountingSummary, listSettlements, listPaymentCandidates, transferToCa, sendToCa,
} from '../controllers/tds.controller.js';

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/deductees', requireAnyPermission(['tds', 'clients'], 'read'), listDeductees);
router.get('/summary', requireAnyPermission(['tds','dashboard','daybook','balance_sheet'], 'read'), getAccountingSummary);
router.get('/settlements', requireAnyPermission(['tds','dashboard','daybook','balance_sheet'], 'read'), listSettlements);
router.get('/payment-candidates', requirePermission('tds', 'read'), listPaymentCandidates);
router.get('/', requirePermission('tds', 'read'), listDeductions);
router.post('/', requirePermission('tds', 'write'), createDeduction);
router.post('/deposit', requirePermission('tds', 'update'), recordDeposit);
router.post('/ca-transfer', requirePermission('tds', 'update'), transferToCa);
router.post('/send-to-ca', requirePermission('tds', 'update'), sendToCa);
router.put('/:id', requirePermission('tds', 'update'), updateDeduction);
router.delete('/:id', requirePermission('tds', 'delete'), deleteDeduction);

export default router;
