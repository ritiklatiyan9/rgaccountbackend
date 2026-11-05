import asyncHandler from '../utils/asyncHandler.js';
import { excelUploadAllowed, listCaWorkflowUsers, setCaWorkflowUser } from '../services/caWorkflow.service.js';
import { importCatalog, prepareExcelImport } from '../services/caExcelImport.service.js';

export const getCaWorkflow = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ users: await listCaWorkflowUsers(req.user) });
});
export const updateCaWorkflow = asyncHandler(async (req, res) => {
  const result = await setCaWorkflowUser(req.user, req.params.userId, req.body?.enabled);
  res.set('Cache-Control', 'no-store').json({ ...result, message: result.excel_upload_enabled ? 'Excel upload enabled across all modules' : 'Excel upload access removed' });
});
export const getExcelUploadAccess = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ enabled: await excelUploadAllowed(req.user) });
});
export const getExcelImportCatalog = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json({ modules: await importCatalog(req.user, req.query.site_id) });
});
// Continue through the ordinary route stack, including its role, site, cache,
// transaction-date and approval middleware. No alternate create implementation.
export async function routeExcelImport(req, _res, next) {
  try {
    const { target, body } = await prepareExcelImport(req.user, req.body);
    req.caExcelImport = { module: req.body.module, originalUrl: req.originalUrl };
    req.url = target;
    // Date/TDS policies resolve their source using originalUrl as well as url.
    req.originalUrl = target;
    req.body = body;
    next();
  } catch (error) { next(error); }
}
