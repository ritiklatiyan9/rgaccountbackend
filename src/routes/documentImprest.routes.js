import express from 'express';
import multer from 'multer';
import path from 'path';

import {
  listDocumentImprest, createDocumentImprest, returnDocumentImprest,
  updateDocumentImprest, deleteDocumentImprest,
} from '../controllers/documentImprest.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';

const router = express.Router();

// In-memory storage — the buffer goes straight to the shared S3 util (same approach
// as plot-documents). Proofs are camera captures, so images only, 10 MB cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(jpg|jpeg|png|webp)$/.test(path.extname(file.originalname).toLowerCase());
    const okMime = /^image\/(jpe?g|png|webp)$/.test(file.mimetype);
    if (okExt && okMime) return cb(null, true);
    cb(new Error('Proof must be a photo (jpg, png or webp)'));
  },
});

router.use(authMiddleware);

router.get('/', listDocumentImprest);
router.post('/', upload.single('photo'), createDocumentImprest);
router.post('/:id/return', upload.single('photo'), returnDocumentImprest);
router.put('/:id', requirePermission('document_imprest', 'update'), updateDocumentImprest);
router.delete('/:id', requirePermission('document_imprest', 'delete'), deleteDocumentImprest);

export default router;
