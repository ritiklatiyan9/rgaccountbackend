import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  getTransferOptions, handleTransferError, transferEntry,
} from '../controllers/transactionTransfer.controller.js';

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'sub_admin'));

router.get('/options', getTransferOptions);
router.post('/', transferEntry);
router.use(handleTransferError);

export default router;
