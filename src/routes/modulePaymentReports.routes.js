import express from 'express';
import auth from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import requireSiteAccess from '../middlewares/plotSiteAccess.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { MODULE_REPORTS, loadModuleReport } from '../services/modulePaymentReports.service.js';

const router = express.Router();
router.use(auth, requireRole('admin', 'sub_admin'));
router.get('/:report', (req, res, next) => {
  const key = req.params.report;
  if (!Object.hasOwn(MODULE_REPORTS, key)) return res.status(404).json({ message: 'Report not found.' });
  const raw = req.query.site_id;
  const site = !Array.isArray(raw) && /^\d+$/.test(String(raw || '')) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(site) || site <= 0 || site > 2147483647) return res.status(400).json({ message: 'A valid site_id is required.' });
  return requirePermission(MODULE_REPORTS[key], 'read')(req, res, next);
}, requireSiteAccess({ entity: 'site', source: 'query', key: 'site_id' }), asyncHandler(async (req, res) => {
  const key = req.params.report;
  const visibility = await resolveEntryVisibility(req.user, MODULE_REPORTS[key], req.query.created_by);
  if (visibility.creatorId === -1) return res.status(400).json({ message: 'Choose valid entry users.' });
  const rows = await loadModuleReport(key, Number(req.query.site_id), visibility.creatorId);
  res.json({ rows, generated_at: new Date().toISOString(), receipt_scope: visibility.creatorId == null ? 'all' : 'creator' });
}));
export default router;
