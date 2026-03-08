import express from 'express';
const router = express.Router();

import {
  createCommission,
  listCommissions,
  getAutocomplete,
  getCommission,
  updateCommission,
  deleteCommission,
} from '../controllers/commission.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';

// All commission routes require auth
router.use(authMiddleware);

router.get('/', listCommissions);                           // ?site_id=X
router.get('/autocomplete', getAutocomplete);               // ?site_id=X
router.get('/:id', getCommission);
router.post('/', requireRole('admin', 'sub_admin'), createCommission);
router.put('/:id', requireRole('admin', 'sub_admin'), updateCommission);
router.delete('/:id', requireRole('admin', 'sub_admin'), deleteCommission);

export default router;
