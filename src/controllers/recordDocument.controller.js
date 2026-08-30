import crypto from 'crypto';
import path from 'path';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { deletePlotDoc, getPlotDocUrl, uploadPlotDoc } from '../utils/plotDocStorage.js';

const VALID_CATEGORIES = new Set(['GENERAL', 'AGREEMENT', 'INVOICE', 'RECEIPT', 'QUOTATION', 'OTHER']);
const VALID_PAYMENT_MODES = new Set(['CASH', 'BANK', 'CHEQUE', 'OTHER']);
const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Keep table names and the permission boundary server-owned. The client only
// sends one of these keys, never SQL or a table name.
export const RECORD_DOCUMENT_ENTITIES = {
  'plot-commission': {
    module: 'commissions',
    tableSql: "SELECT id, site_id, CONCAT('Plot ', plot_no) AS display_name FROM plots WHERE id = $1",
  },
  cashflow: {
    module: 'cashflow',
    tableSql: 'SELECT id, site_id, ledger_name AS display_name FROM cash_flow_months WHERE id = $1',
  },
  registry: {
    module: 'plot_registry',
    tableSql: "SELECT id, site_id, CONCAT('Plot ', plot_no) AS display_name FROM plot_registries WHERE id = $1",
  },
  vendor: {
    module: 'vendors',
    tableSql: 'SELECT id, site_id, vendor_name AS display_name FROM vendor_commitments WHERE id = $1',
  },
  construction: {
    module: 'construction',
    tableSql: 'SELECT id, site_id, name AS display_name FROM construction_projects WHERE id = $1',
  },
  inventory: {
    module: 'inventory',
    tableSql: 'SELECT id, site_id, name AS display_name FROM inventory_materials WHERE id = $1',
  },
  imprest: {
    module: 'imprest',
    tableSql: 'SELECT id, id::text AS display_name FROM sites WHERE id = $1',
  },
};

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export const getRecordDocumentEntity = (value) => RECORD_DOCUMENT_ENTITIES[String(value || '')] || null;

const ensureSiteAccess = async (req, res, siteId) => {
  if (['admin', 'super_admin'].includes(req.user?.role)) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (rows[0]) return true;
  res.status(403).json({ message: 'Access denied to this site' });
  return false;
};

const getEntity = async (req, res) => {
  const entity = getRecordDocumentEntity(req.params.entityType);
  const entityId = parseId(req.params.entityId);
  if (!entity) {
    res.status(400).json({ message: 'Unsupported document record type' });
    return null;
  }
  if (!entityId) {
    res.status(400).json({ message: 'A valid record id is required' });
    return null;
  }
  const { rows } = await pool.query(entity.tableSql, [entityId]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Record not found' });
    return null;
  }
  if (!await ensureSiteAccess(req, res, rows[0].site_id || rows[0].id)) return null;
  return { ...rows[0], id: entityId, entityType: req.params.entityType, config: entity };
};

const withUrl = async (document) => {
  const result = { ...document };
  try { result.file_url = await getPlotDocUrl(result.file_path); } catch { result.file_url = null; }
  delete result.file_path;
  return result;
};

/** GET /record-documents/:entityType/:entityId */
export const listRecordDocuments = asyncHandler(async (req, res) => {
  const record = await getEntity(req, res);
  if (!record) return;
  const paymentMode = String(req.query.payment_mode || '').toUpperCase();
  const params = [record.entityType, record.id];
  const modeFilter = VALID_PAYMENT_MODES.has(paymentMode) ? ` AND d.payment_mode = $3` : '';
  if (modeFilter) params.push(paymentMode);
  const { rows } = await pool.query(
    `SELECT d.id, d.type, d.category, d.title, d.original_name, d.file_path, d.mime_type,
            d.file_size, d.uploaded_source, d.payment_mode, d.created_at,
            COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.entity_type = $1
        AND d.entity_id = $2
        AND d.uploaded_source = 'ACCOUNT_RECORD'${modeFilter}
      ORDER BY d.created_at DESC, d.id DESC`,
    params
  );
  res.json({ record, documents: await Promise.all(rows.map(withUrl)) });
});

/** POST /record-documents/:entityType/:entityId */
export const uploadRecordDocument = asyncHandler(async (req, res) => {
  const record = await getEntity(req, res);
  if (!record) return;
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });

  const requestedCategory = String(req.body.category || 'GENERAL').toUpperCase();
  const category = VALID_CATEGORIES.has(requestedCategory) ? requestedCategory : 'GENERAL';
  const requestedMode = String(req.body.payment_mode || '').toUpperCase();
  const paymentMode = VALID_PAYMENT_MODES.has(requestedMode) ? requestedMode : null;
  const title = String(req.body.title || req.file.originalname || 'Document').trim().slice(0, 300) || 'Document';
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const suppliedMime = String(req.file.mimetype || '').toLowerCase();
  const mimeType = suppliedMime === 'application/octet-stream'
    ? (MIME_BY_EXTENSION[path.extname(req.file.originalname || '').toLowerCase()] || suppliedMime)
    : suppliedMime;
  let storageKey;

  try {
    storageKey = await uploadPlotDoc(req.file.buffer, req.file.originalname, mimeType, 'record_documents');
    const { rows } = await pool.query(
      `INSERT INTO documents
         (site_id, type, category, title, original_name, file_path, file_hash,
          mime_type, file_size, ocr_status, ocr_engine, ocr_completed_at,
          uploaded_source, uploaded_by, entity_type, entity_id, payment_mode)
       VALUES ($1, 'OTHER', $2, $3, $4, $5, $6, $7, $8,
               'DONE', 'none', now(), 'ACCOUNT_RECORD', $9, $10, $11, $12)
       RETURNING id, type, category, title, original_name, file_path, mime_type,
                 file_size, uploaded_source, payment_mode, created_at`,
      [record.site_id || record.id, category, title, req.file.originalname, storageKey,
       fileHash, mimeType, req.file.size, req.user?.id || null,
       record.entityType, record.id, paymentMode]
    );
    res.status(201).json(await withUrl(rows[0]));
  } catch (error) {
    if (storageKey) await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  }
});

/** DELETE /record-documents/:entityType/:entityId/:documentId */
export const deleteRecordDocument = asyncHandler(async (req, res) => {
  const record = await getEntity(req, res);
  if (!record) return;
  const documentId = parseId(req.params.documentId);
  if (!documentId) return res.status(400).json({ message: 'A valid document id is required' });

  const { rows } = await pool.query(
    `SELECT id, file_path
       FROM documents
      WHERE id = $1 AND entity_type = $2 AND entity_id = $3
        AND uploaded_source = 'ACCOUNT_RECORD'`,
    [documentId, record.entityType, record.id]
  );
  if (!rows[0]) return res.status(404).json({ message: 'Document not found' });
  const deleted = await pool.query(
    `DELETE FROM documents
      WHERE id = $1 AND entity_type = $2 AND entity_id = $3
        AND uploaded_source = 'ACCOUNT_RECORD'
      RETURNING id, file_path`,
    [documentId, record.entityType, record.id]
  );
  if (!deleted.rows[0]) return res.status(404).json({ message: 'Document not found' });
  // Retain the object while this record is recoverable from Recycle Bin.
  res.json({ message: 'Document deleted', documentId });
});
