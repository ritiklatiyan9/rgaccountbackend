import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { getReceiptHistory, recordReceiptPrint } from '../controllers/receiptHistory.controller.js';

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.post('/prints', recordReceiptPrint);
router.get('/:module/:recordId', getReceiptHistory);

export default router;
