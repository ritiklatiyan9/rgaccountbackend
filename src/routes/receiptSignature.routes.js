import express from 'express';
import multer from 'multer';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import requireRole from '../middlewares/role.middleware.js';
import asyncHandler from '../utils/asyncHandler.js';
import {
  emptyReceiptSignature, getReceiptSignature, MAX_SIGNATURE_BYTES,
  MIN_SIGNATURE_SIZE_PERCENT, MAX_SIGNATURE_SIZE_PERCENT,
  prepareReceiptSignature, saveReceiptSignature,
} from '../services/receiptSignature.service.js';

const receiveImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_SIGNATURE_BYTES, files: 1, fields: 0 } }).single('file');

export function createReceiptSignatureRouter({ authenticate = authMiddleware, database = pool } = {}) {
  const router = express.Router();
  router.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const siteAccess = asyncHandler(async (req, res, next) => {
    const raw = req.query.site_id ?? req.body?.site_id;
    const siteId = Number(raw);
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(siteId) || siteId < 1) {
      return res.status(400).json({ message: 'Select a valid site.' });
    }
    const { rows } = await database.query('SELECT id FROM sites WHERE id = $1 AND organization_id = $2 LIMIT 1', [siteId, req.user.organization_id]);
    if (!rows.length) return res.status(404).json({ message: 'Site not found.' });
    if (!['admin', 'super_admin'].includes(req.user.role)) {
      const access = await database.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [req.user.id, siteId]);
      if (!access.rows.length) return res.status(403).json({ message: 'Access denied to this site.' });
    }
    req.receiptSignatureSiteId = siteId;
    next();
  });
  const respond = (res, siteId, signature) => res.json({ site_id: siteId, signature });
  router.get('/', siteAccess, asyncHandler(async (req, res) => {
    respond(res, req.receiptSignatureSiteId, await getReceiptSignature(req.receiptSignatureSiteId, database));
  }));
  router.post('/', requireRole('admin'), siteAccess, (req, res, next) => {
    receiveImage(req, res, error => {
      if (!error) return next();
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message: error.code === 'LIMIT_FILE_SIZE'
        ? 'Signature images must be 5 MB or smaller.' : 'Upload one PNG, JPG or JPEG image.' });
    });
  }, asyncHandler(async (req, res) => {
    const siteId = req.receiptSignatureSiteId;
    const image = await prepareReceiptSignature(req.file);
    const previous = await getReceiptSignature(siteId, database);
    respond(res, siteId, await saveReceiptSignature(siteId, { ...previous, ...image }, req.user.id));
  }));
  router.put('/', requireRole('admin'), siteAccess, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const hasEnabled = Object.hasOwn(body, 'enabled'), hasSize = Object.hasOwn(body, 'size_percent');
    if (!hasEnabled && !hasSize) return res.status(400).json({ message: 'Choose a signature setting to update.' });
    if (hasEnabled && typeof body.enabled !== 'boolean') return res.status(400).json({ message: 'enabled must be a boolean.' });
    if (hasSize && (!Number.isInteger(body.size_percent) || body.size_percent < MIN_SIGNATURE_SIZE_PERCENT || body.size_percent > MAX_SIGNATURE_SIZE_PERCENT)) {
      return res.status(400).json({ message: `Signature size must be a whole percentage between ${MIN_SIGNATURE_SIZE_PERCENT} and ${MAX_SIGNATURE_SIZE_PERCENT}.` });
    }
    const siteId = req.receiptSignatureSiteId;
    const previous = await getReceiptSignature(siteId, database);
    if (body.enabled && !previous.image_data_url) return res.status(400).json({ message: 'Upload a signature before enabling it.' });
    respond(res, siteId, await saveReceiptSignature(siteId, { ...previous,
      ...(hasEnabled ? { enabled: body.enabled } : {}), ...(hasSize ? { size_percent: body.size_percent } : {}),
    }, req.user.id));
  }));
  router.delete('/', requireRole('admin'), siteAccess, asyncHandler(async (req, res) => {
    const siteId = req.receiptSignatureSiteId;
    respond(res, siteId, await saveReceiptSignature(siteId, emptyReceiptSignature(), req.user.id));
  }));
  return router;
}

export default createReceiptSignatureRouter();
