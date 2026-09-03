import express from 'express';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import {
  compressedJsonBody,
  listWorkbooks, createWorkbook, convertLegacyFile, getWorkbook, updateWorkbook, deleteWorkbook,
  restoreWorkbook, duplicateWorkbook, saveChanges, listVersions, getVersion, createVersion, restoreVersion,
  listShares, upsertShare, deleteShare, recordExport,
} from '../controllers/spreadsheet.controller.js';

/**
 * Native spreadsheet workbooks. Two layers guard every route:
 *  1. module RBAC (`excel` read/write/update/delete/restore) via requirePermission;
 *  2. per-workbook tenant/site/share access resolved inside the controller.
 * A viewer-level share therefore never reaches a write handler even with the
 * module `update` permission, and vice versa.
 */
const router = express.Router();
router.use(authMiddleware);

router.get('/', requirePermission('excel', 'read'), listWorkbooks);
router.post('/', requirePermission('excel', 'write'), ...compressedJsonBody, createWorkbook);
router.post('/legacy/:fileId', requirePermission('excel', 'write'), ...compressedJsonBody, convertLegacyFile);

router.get('/:id', requirePermission('excel', 'read'), getWorkbook);
router.patch('/:id', requirePermission('excel', 'update'), updateWorkbook);
router.delete('/:id', requirePermission('excel', 'delete'), deleteWorkbook);
router.post('/:id/restore', requirePermission('excel', 'restore'), restoreWorkbook);
router.post('/:id/duplicate', requirePermission('excel', 'write'), duplicateWorkbook);
router.post('/:id/changes', requirePermission('excel', 'update'), ...compressedJsonBody, saveChanges);
router.post('/:id/export', requirePermission('excel', 'read'), recordExport);

router.get('/:id/versions', requirePermission('excel', 'read'), listVersions);
router.post('/:id/versions', requirePermission('excel', 'update'), createVersion);
router.get('/:id/versions/:versionId', requirePermission('excel', 'read'), getVersion);
router.post('/:id/versions/:versionId/restore', requirePermission('excel', 'update'), restoreVersion);

router.get('/:id/shares', requirePermission('excel', 'read'), listShares);
router.put('/:id/shares', requirePermission('excel', 'update'), upsertShare);
router.delete('/:id/shares/:userId', requirePermission('excel', 'update'), deleteShare);

export default router;
