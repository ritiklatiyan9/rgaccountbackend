import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  listPlotsWithDocs, getPlotDocuments, uploadPlotDocument, deletePlotDocument,
} from '../controllers/plotDocument.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();

// In-memory storage so we hand the buffer straight to the shared S3 util (same approach as
// the booking module). Accept images + pdf + doc/docx, 25 MB cap (registry deed scans run large;
// the client compresses PDFs losslessly before upload).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpg|jpeg|png|webp|pdf|doc|docx)$/;
    const allowedMime = /jpg|jpeg|png|webp|pdf|msword|officedocument\.wordprocessingml/;
    const okExt = allowedExt.test(path.extname(file.originalname).toLowerCase());
    const okMime = allowedMime.test(file.mimetype) || file.mimetype === 'application/octet-stream';
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf, doc, docx)'));
  },
});

// All plot-document routes require auth. Access reuses the plot_payments permission.
router.use(authMiddleware);

router.get('/', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), listPlotsWithDocs);                          // ?site_id=X
router.get('/:plotId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'read'), getPlotDocuments);
router.post('/:plotId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'write'), upload.single('file'), uploadPlotDocument);
router.delete('/doc/:docId', requireRole('admin', 'sub_admin'), requirePermission('plot_payments', 'delete'), deletePlotDocument);

export default router;
