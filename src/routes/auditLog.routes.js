import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { listAuditLogs } from '../controllers/auditLog.controller.js';

const router = express.Router();

router.get('/', authMiddleware, requirePermission('audit_logs', 'read'), listAuditLogs);

export default router;
