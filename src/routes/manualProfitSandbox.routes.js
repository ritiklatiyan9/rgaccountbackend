import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import {
  createManualProfitSandbox,
  deleteManualProfitSandbox,
  listManualProfitSandboxes,
  updateManualProfitSandbox,
} from '../controllers/manualProfitSandbox.controller.js';

const router = express.Router();

router.use(authMiddleware, requireRole('admin'));
router.get('/', listManualProfitSandboxes);
router.post('/', createManualProfitSandbox);
router.put('/:id', updateManualProfitSandbox);
router.delete('/:id', deleteManualProfitSandbox);

export default router;
