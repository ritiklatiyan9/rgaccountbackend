import express from 'express';
import multer from 'multer';
import path from 'path';

import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import {
  getRecordDocumentEntity,
  listRecordDocuments,
  uploadRecordDocument,
  deleteRecordDocument,
} from '../controllers/recordDocument.controller.js';

const router = express.Router();
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const expected = ALLOWED.get(extension);
    const supplied = String(file.mimetype || '').toLowerCase();
    if (expected && (supplied === expected || supplied === 'application/octet-stream')) {
      return callback(null, true);
    }
    callback(new Error('Invalid file type (allowed: jpg, jpeg, png, webp, pdf, doc, docx)'));
  },
});

const receive = (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File is too large. The maximum size is 25 MB.' });
    }
    return res.status(400).json({ message: error.message || 'The selected file could not be uploaded.' });
  });
};

const documentPermission = (action) => async (req, res, next) => {
  const entity = getRecordDocumentEntity(req.params.entityType);
  if (!entity) return res.status(400).json({ message: 'Unsupported document record type' });
  return requirePermission(entity.module, action)(req, res, next);
};

router.use(authMiddleware, requireRole('admin', 'sub_admin'));
router.get('/:entityType/:entityId', documentPermission('read'), listRecordDocuments);
router.post('/:entityType/:entityId', documentPermission('write'), receive, uploadRecordDocument);
router.delete('/:entityType/:entityId/:documentId', documentPermission('delete'), deleteRecordDocument);

export default router;
