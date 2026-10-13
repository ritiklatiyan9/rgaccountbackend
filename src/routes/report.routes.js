import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import { listReportModules, getReport, aiReportSummary } from '../controllers/report.controller.js';

const router = express.Router();

router.use(authMiddleware, requireRole('admin', 'sub_admin'));

// Per-module read permission is enforced inside the controller.
router.get('/modules', listReportModules);
// Authorization depends on the selected report and site inside getReport.
// Always run that boundary and read current financial totals after a mutation.
router.get('/:module', getReport);
router.post('/:module/ai', aiReportSummary);

export default router;
