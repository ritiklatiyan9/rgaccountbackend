import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import {
  listDeductions, createDeduction, updateDeduction, deleteDeduction, recordDeposit, listDeductees,
} from '../controllers/tds.controller.js';

const router = express.Router();
router.use(authMiddleware, requireRole('admin', 'sub_admin'));

router.get('/deductees', requirePermission('tds', 'read'), listDeductees);
router.get('/', requirePermission('tds', 'read'), listDeductions);
router.post('/', requirePermission('tds', 'write'), createDeduction);
router.post('/deposit', requirePermission('tds', 'update'), recordDeposit);
router.put('/:id', requirePermission('tds', 'update'), updateDeduction);
router.delete('/:id', requirePermission('tds', 'delete'), deleteDeduction);

export default router;
