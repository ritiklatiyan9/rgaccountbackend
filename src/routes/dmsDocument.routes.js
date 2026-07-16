import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  uploadDmsDocument, searchDmsDocuments, getDmsDocument,
  updateDmsDocument, retryOcr, deleteDmsDocument,
} from '../controllers/dmsDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();

// In-memory storage → hand the buffer straight to the shared S3 util + OCR. 25 MB cap (deed scans
// run large; the client compresses before upload). Same accept-set as plotDocument.routes.js.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(jpg|jpeg|png|webp|pdf|doc|docx)$/.test(path.extname(file.originalname).toLowerCase());
    const okMime = /jpg|jpeg|png|webp|pdf|msword|officedocument\.wordprocessingml/.test(file.mimetype)
      || file.mimetype === 'application/octet-stream';
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf, doc, docx)'));
  },
});

router.use(authMiddleware);

// Access reuses the plot_registry permission — these are registry/legal documents.
// ponytail: swap to a dedicated 'documents' perm only if DMS access must diverge from Plot Registry.
router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), searchDmsDocuments);
router.get('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'read'), getDmsDocument);
router.post('/', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), upload.single('file'), uploadDmsDocument);
router.post('/:id/retry-ocr', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'write'), retryOcr);
router.patch('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'update'), updateDmsDocument);
router.delete('/:id', requireRole('admin', 'sub_admin'), requirePermission('plot_registry', 'delete'), deleteDmsDocument);

export default router;
