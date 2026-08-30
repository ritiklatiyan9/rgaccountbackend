import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { deletePlotDoc, getPlotDocUrl, uploadPlotDoc } from '../utils/plotDocStorage.js';

const VALID_CATEGORIES = new Set(['LAND_RECORD', 'AGREEMENT', 'ID_PROOF', 'BANK_PROOF', 'RECEIPT', 'OTHER']);

const ensureSiteAccess = async (req, res, siteId) => {
  if (req.user.role === 'admin' || req.user.role === 'super_admin') return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId],
  );
  if (rows[0]) return true;
  res.status(403).json({ message: 'Access denied to this site' });
  return false;
};

const getFarmer = async (farmerId) => {
  const { rows } = await pool.query(
    'SELECT id, name, phone, address, site_id FROM farmers WHERE id = $1',
    [farmerId],
  );
  return rows[0] || null;
};

/** GET /farmers/:farmerId/documents */
export const getFarmerDocuments = asyncHandler(async (req, res) => {
  const farmer = await getFarmer(req.params.farmerId);
  if (!farmer) return res.status(404).json({ message: 'Farmer not found' });
  if (!await ensureSiteAccess(req, res, farmer.site_id)) return;

  const { rows: documents } = await pool.query(
    `SELECT d.id, d.type, d.category, d.title, d.original_name, d.file_path,
            d.mime_type, d.file_size, d.uploaded_source, d.payment_mode, d.created_at,
            COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.farmer_id = $1
        AND d.uploaded_source = 'FARMER'
      ORDER BY d.created_at DESC, d.id DESC`,
    [farmer.id],
  );

  for (const document of documents) {
    try { document.file_url = await getPlotDocUrl(document.file_path); } catch { document.file_url = null; }
  }
  res.json({ farmer, documents });
});

/** POST /farmers/:farmerId/documents */
export const uploadFarmerDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });
  const farmer = await getFarmer(req.params.farmerId);
  if (!farmer) return res.status(404).json({ message: 'Farmer not found' });
  if (!await ensureSiteAccess(req, res, farmer.site_id)) return;

  const requestedCategory = String(req.body.category || 'OTHER').toUpperCase();
  const category = VALID_CATEGORIES.has(requestedCategory) ? requestedCategory : 'OTHER';
  const requestedPaymentMode = String(req.body.payment_mode || '').toUpperCase();
  const paymentMode = ['BANK', 'CASH'].includes(requestedPaymentMode) ? requestedPaymentMode : null;
  const title = req.body.title ? String(req.body.title).trim() : null;
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  let storageKey;

  try {
    storageKey = await uploadPlotDoc(req.file.buffer, req.file.originalname, req.file.mimetype, 'farmer_documents');
    const { rows } = await pool.query(
      `INSERT INTO documents
         (farmer_id, site_id, type, category, title, original_name, file_path,
          file_hash, mime_type, file_size, ocr_status, ocr_engine, ocr_completed_at,
          uploaded_source, uploaded_by, payment_mode)
       VALUES ($1, $2, 'OTHER', $3, $4, $5, $6, $7, $8, $9, 'DONE', 'none', now(), 'FARMER', $10, $11)
       RETURNING id, type, category, title, original_name, file_path, mime_type, file_size,
                 uploaded_source, payment_mode, created_at`,
      [
        farmer.id, farmer.site_id, category, title, req.file.originalname, storageKey,
        fileHash, req.file.mimetype, req.file.size, req.user?.id || null, paymentMode,
      ],
    );
    const document = rows[0];
    try { document.file_url = await getPlotDocUrl(document.file_path); } catch { document.file_url = null; }
    res.status(201).json(document);
  } catch (error) {
    if (storageKey) await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  }
});

/** DELETE /farmers/documents/:docId */
export const deleteFarmerDocument = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.file_path, d.farmer_id, f.site_id
       FROM documents d
       JOIN farmers f ON f.id = d.farmer_id
      WHERE d.id = $1 AND d.uploaded_source = 'FARMER'
      LIMIT 1`,
    [req.params.docId],
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found' });
  if (!await ensureSiteAccess(req, res, document.site_id)) return;

  const deleted = await pool.query(
    `DELETE FROM documents WHERE id = $1 AND farmer_id = $2 AND uploaded_source = 'FARMER'
      RETURNING id, file_path`,
    [document.id, document.farmer_id],
  );
  if (!deleted.rows[0]) return res.status(404).json({ message: 'Document not found' });
  // Retain the object while this record is recoverable from Recycle Bin.
  res.json({ message: 'Document deleted', documentId: document.id });
});
