import express from 'express';
import { getBalanceSheet } from '../controllers/balanceSheet.controller.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import requirePermission from '../middlewares/permission.middleware.js';
import { cacheResponse } from '../middlewares/cache.middleware.js';
import multer from 'multer';
import path from 'node:path';
import requireRegistrySiteAccess from '../middlewares/registrySiteAccess.middleware.js';
import { getYearEndRequirements, saveYearEndRequirement, uploadYearEndAttachment } from '../controllers/yearEndRequirements.controller.js';

const router = express.Router();

router.use(authMiddleware);
const yearEndAccess = [requireRole('admin', 'sub_admin'), requirePermission('balance_sheet', 'read'),
  requireRegistrySiteAccess({entity:'site',source:'query',key:'site_id'})];
const attachmentUpload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:25*1024*1024,files:1 },
  fileFilter:(_req,file,done) => {
    const types={'.pdf':['application/pdf'],'.png':['image/png'],'.jpg':['image/jpeg'],'.jpeg':['image/jpeg'],
      '.webp':['image/webp'],'.xlsx':['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      '.xls':['application/vnd.ms-excel'],'.docx':['application/vnd.openxmlformats-officedocument.wordprocessingml.document']};
    const matches=types[path.extname(file.originalname).toLowerCase()];
    done(matches && (matches.includes(file.mimetype) || file.mimetype==='application/octet-stream') ? null : new Error('Use PDF, Excel, Word, JPG, PNG or WEBP.'),Boolean(matches));
  },
}).single('file');
router.get('/year-end',...yearEndAccess,getYearEndRequirements);
router.put('/year-end/checklist',...yearEndAccess,requireRole('admin'),saveYearEndRequirement);
router.post('/year-end/attachments',...yearEndAccess,requireRole('admin'),(req,res,next) => {
  attachmentUpload(req,res,error => error ? res.status(400).json({message:error.code==='LIMIT_FILE_SIZE' ? 'Maximum file size is 25 MB.' : error.message}) : next());
},uploadYearEndAttachment);
router.get(
  '/',
  requireRole('admin', 'sub_admin'),
  requirePermission('balance_sheet', 'read'),
  // Avoid retaining multi-megabyte full-history payloads in the in-process
  // cache. Small/date-filtered statements still benefit from the 30s cache.
  cacheResponse({
    ttlSeconds: 30,
    namespace: 'balance-sheet',
    shouldCache: (payload) => (payload?.transactions?.length || 0) <= 1000,
  }),
  getBalanceSheet,
);

export default router;
