import express from 'express';
const router = express.Router();

import {
  createFarmer,
  listFarmers,
  getFarmer,
  updateFarmer,
  deleteFarmer,
  bulkDeleteFarmers,
  createPayment,
  listPayments,
  updatePayment,
  deletePayment,
  bulkDeletePayments,
  listFarmerMembers,
  verifyFarmerReceipt,
} from '../controllers/farmer.controller.js';
import {
  deleteFarmerDocument, getFarmerDocuments, uploadFarmerDocument,
} from '../controllers/farmerDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse, invalidateCacheOnSuccess } from '../middlewares/cache.middleware.js';
import multer from 'multer';
import path from 'path';

const farmerReadCache = cacheResponse({ ttlSeconds: 30, namespace: 'farmers' });
// Member-list dropdown rarely changes; longer TTL in a separate namespace so
// farmer-payment writes don't bust it.
const farmerMembersCache = cacheResponse({ ttlSeconds: 300, namespace: 'farmers-members' });
// Farmer mutations affect daybook dashboard too. Anchored prefix so the
// "farmers-members" cache survives.
const bustFarmerCache = invalidateCacheOnSuccess(['farmers|', '/daybook']);
const MIME_BY_EXTENSION = new Map([
  ['.jpg', new Set(['image/jpeg'])], ['.jpeg', new Set(['image/jpeg'])],
  ['.png', new Set(['image/png'])], ['.webp', new Set(['image/webp'])],
  ['.pdf', new Set(['application/pdf'])], ['.doc', new Set(['application/msword'])],
  ['.docx', new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document'])],
]);
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const suppliedMime = String(file.mimetype || '').toLowerCase();
    const expectedMimes = MIME_BY_EXTENSION.get(extension);
    if (expectedMimes && (expectedMimes.has(suppliedMime) || suppliedMime === 'application/octet-stream')) return callback(null, true);
    return callback(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf, doc, docx)'));
  },
});
const receiveFarmerDocument = (req, res, next) => {
  documentUpload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File is too large. The maximum size is 25 MB.' });
    }
    return res.status(400).json({ message: error.message || 'The selected file could not be uploaded.' });
  });
};

// Public: verify receipt (no auth) — MUST be before authMiddleware
router.get('/verify-receipt', verifyFarmerReceipt);

// All farmer routes require auth
router.use(authMiddleware);

// Farmer members (for registration dropdown) — must come before /:id
router.get('/members', farmerMembersCache, listFarmerMembers);

// Farmer documents — scoped to the farmer, stored in the shared document bucket.
router.get('/:farmerId/documents', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), getFarmerDocuments);
router.post('/:farmerId/documents', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'write'), receiveFarmerDocument, bustFarmerCache, uploadFarmerDocument);
router.delete('/documents/:docId', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), bustFarmerCache, deleteFarmerDocument);

// Farmer CRUD
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), farmerReadCache, listFarmers);                                     // ?site_id=X
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), farmerReadCache, getFarmer);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'write'), bustFarmerCache, createFarmer);
router.put('/:id', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'update'), bustFarmerCache, updateFarmer);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), bustFarmerCache, deleteFarmer);
router.post('/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), bustFarmerCache, bulkDeleteFarmers);

// Farmer Payments (installments)
router.get('/:farmerId/payments', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'read'), farmerReadCache, listPayments);
router.post('/:farmerId/payments', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'write'), bustFarmerCache, createPayment);
router.put('/:farmerId/payments/:paymentId', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'update'), bustFarmerCache, updatePayment);
router.delete('/:farmerId/payments/:paymentId', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), bustFarmerCache, deletePayment);
router.post('/:farmerId/payments/bulk-delete', requireRole('admin', 'sub_admin'), requirePermission('farmers', 'delete'), bustFarmerCache, bulkDeletePayments);

export default router;
