import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { streamPendingLookoutAssistant } from '../controllers/pendingLookoutAssistant.controller.js';

const router = express.Router();

router.use(authMiddleware, requireRole('admin'));
router.post('/assistant', streamPendingLookoutAssistant);

export default router;
