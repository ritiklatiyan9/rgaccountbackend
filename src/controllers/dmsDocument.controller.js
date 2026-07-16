import crypto from 'crypto';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadPlotDoc, getPlotDocUrl, deletePlotDoc } from '../utils/plotDocStorage.js';
import { runDmsOcr, isOcrable } from '../services/dmsOcr.service.js';

/**
 * Document Management System (DMS) — scan/upload legal documents (khatauni, sale deeds,
 * agreements, registry), OCR them (Hindi + English), tag with metadata, and full-text search.
 *
 * Reuses the SHARED `documents` table + S3 storage. DMS rows are marked uploaded_source='DMS'
 * so this module's search/list never mixes with KYC/plot-archival documents. See migration 069
 * for the metadata/ocr_text columns and the tsvector + trigram indexes.
 */

const VALID_CATEGORIES = new Set(['KHATAUNI', 'SALE_DEED', 'AGREEMENT', 'REGISTRY', 'MAP', 'OTHER']);
const normCategory = (c) => {
  const u = String(c || 'OTHER').toUpperCase();
  return VALID_CATEGORIES.has(u) ? u : 'OTHER';
};

// List/card columns — deliberately excludes the (potentially large) ocr_text.
const LIST_COLS = `
  d.id, d.category, d.title, d.original_name, d.file_path, d.mime_type, d.file_size,
  d.metadata, d.doc_date, d.expiry_date, d.ocr_status, d.ocr_engine, d.created_at,
  COALESCE(u.name, u.email) AS uploaded_by_name`;

/**
 * Build a prefix tsquery from a free-text search string. Keeps letters, digits, and Unicode
 * combining marks — the latter is essential: Devanagari vowel signs (ा ी े …) and the halant are
 * category \p{M}, NOT \p{L}, so dropping them would mangle "गाटा" → "गट". Strips punctuation
 * (incl. tsquery operators, preventing injection), prefix-matches each term. '' when no terms.
 */
export const buildTsQuery = (q) =>
  String(q || '')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}\p{M}]/gu, ''))
    .filter(Boolean)
    .map((t) => `${t}:*`)
    .join(' & ');

// ── Async OCR (fire-and-forget) ──────────────────────────────────────────────
// ponytail: no queue — Node handles a few concurrent OCR fetches fine at office volume.
// Add p-limit if bulk imports ever pile up.
const processDmsOcr = async (docId, buffer, mime) => {
  try {
    await pool.query(`UPDATE documents SET ocr_status='PROCESSING', ocr_started_at=now(), updated_at=now() WHERE id=$1`, [docId]);
    const { text, engine } = await runDmsOcr(buffer, mime);
    await pool.query(
      `UPDATE documents SET ocr_text=$1, ocr_status='DONE', ocr_engine=$2, ocr_completed_at=now(), ocr_error=NULL, updated_at=now() WHERE id=$3`,
      [text, engine, docId]
    );
  } catch (err) {
    await pool.query(
      `UPDATE documents SET ocr_status='FAILED', ocr_error=$1, ocr_completed_at=now(), updated_at=now() WHERE id=$2`,
      [String(err?.message || err).slice(0, 2000), docId]
    ).catch(() => {});
    console.error(`[dms ocr] document ${docId} failed:`, err.message);
  }
};

/**
 * POST /documents  (multipart: file, category, title, doc_date, expiry_date, metadata=<JSON>)
 * Stores the file, inserts a DMS document row, responds, then OCRs in the background.
 */
export const uploadDmsDocument = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded (field name: file)' });

  const category = normCategory(req.body.category);
  const title = req.body.title ? String(req.body.title).trim() : (req.file.originalname || '').replace(/\.[^.]+$/, '');
  const docDate = req.body.doc_date || null;
  const expiryDate = req.body.expiry_date || null;
  let metadata = {};
  if (req.body.metadata) { try { metadata = JSON.parse(req.body.metadata); } catch { metadata = {}; } }

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const storageKey = await uploadPlotDoc(req.file.buffer, req.file.originalname, req.file.mimetype);
  const willOcr = isOcrable(req.file.mimetype);

  const { rows } = await pool.query(
    `INSERT INTO documents
       (type, category, title, original_name, file_path, file_hash, mime_type, file_size,
        metadata, doc_date, expiry_date, ocr_status, ocr_engine, ocr_completed_at,
        uploaded_source, uploaded_by)
     VALUES ('OTHER', $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::date, $10::date,
             $11, $12, $13, 'DMS', $14)
     RETURNING id, category, title, original_name, file_path, mime_type, file_size,
               metadata, doc_date, expiry_date, ocr_status, ocr_engine, created_at`,
    [
      category, title, req.file.originalname, storageKey, fileHash, req.file.mimetype, req.file.size,
      JSON.stringify(metadata), docDate, expiryDate,
      willOcr ? 'PENDING' : 'DONE', willOcr ? null : 'none', willOcr ? null : new Date(),
      req.user?.id || null,
    ]
  );

  const doc = rows[0];
  try { doc.file_url = await getPlotDocUrl(doc.file_path); } catch { doc.file_url = null; }
  res.status(201).json(doc);

  if (willOcr) processDmsOcr(doc.id, req.file.buffer, req.file.mimetype);
});

/**
 * GET /documents  (?q, category, from, to, expiring, limit, offset)
 * Google-like full-text search + filters over DMS documents. Falls back to fuzzy ILIKE when the
 * prefix-FTS finds nothing (e.g. a number buried mid-token in the OCR text).
 */
export const searchDmsDocuments = asyncHandler(async (req, res) => {
  const { q, category, from, to, expiring } = req.query;
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };

  const filters = [`d.uploaded_source = 'DMS'`];
  if (category && category !== 'ALL') filters.push(`d.category = ${add(String(category).toUpperCase())}`);
  if (from) filters.push(`d.doc_date >= ${add(from)}::date`);
  if (to) filters.push(`d.doc_date <= ${add(to)}::date`);
  if (expiring) filters.push(`d.expiry_date IS NOT NULL AND d.expiry_date <= (CURRENT_DATE + ${add(Number(expiring) || 30)}::int)`);

  const tsq = buildTsQuery(q);
  let rows;

  if (tsq) {
    const qp = add(tsq);
    const sql = `
      SELECT ${LIST_COLS},
             ts_rank(d.search_tsv, to_tsquery('simple', ${qp})) AS rank,
             ts_headline('simple', left(coalesce(d.ocr_text, d.title, ''), 20000),
                         to_tsquery('simple', ${qp}),
                         'MaxFragments=2,MinWords=3,MaxWords=14,StartSel=«,StopSel=»') AS snippet
        FROM documents d
        LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE ${filters.join(' AND ')}
         AND d.search_tsv @@ to_tsquery('simple', ${qp})
       ORDER BY rank DESC, d.created_at DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    ({ rows } = await pool.query(sql, params));

    // Fuzzy substring fallback (only worth it on the first page).
    if (rows.length === 0 && offset === 0) {
      const lp = [];
      const ladd = (v) => { lp.push(v); return `$${lp.length}`; };
      const base = [`d.uploaded_source = 'DMS'`];
      if (category && category !== 'ALL') base.push(`d.category = ${ladd(String(category).toUpperCase())}`);
      if (from) base.push(`d.doc_date >= ${ladd(from)}::date`);
      if (to) base.push(`d.doc_date <= ${ladd(to)}::date`);
      const like = ladd(`%${String(q).trim()}%`);
      const sql2 = `
        SELECT ${LIST_COLS}, 0::float4 AS rank, NULL::text AS snippet
          FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE ${base.join(' AND ')}
           AND (d.ocr_text ILIKE ${like} OR d.title ILIKE ${like}
                OR d.original_name ILIKE ${like} OR d.metadata::text ILIKE ${like})
         ORDER BY d.created_at DESC
         LIMIT ${ladd(limit)}`;
      ({ rows } = await pool.query(sql2, lp));
    }
  } else {
    const sql = `
      SELECT ${LIST_COLS}, 0::float4 AS rank, NULL::text AS snippet
        FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE ${filters.join(' AND ')}
       ORDER BY d.created_at DESC
       LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    ({ rows } = await pool.query(sql, params));
  }

  for (const d of rows) {
    try { d.file_url = await getPlotDocUrl(d.file_path); } catch { d.file_url = null; }
  }
  res.json({ documents: rows });
});

/** GET /documents/:id  → full record incl. ocr_text + a fresh signed URL. */
export const getDmsDocument = asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.category, d.title, d.original_name, d.file_path, d.mime_type, d.file_size,
            d.metadata, d.doc_date, d.expiry_date, d.ocr_status, d.ocr_engine, d.ocr_error,
            d.ocr_text, d.created_at, COALESCE(u.name, u.email) AS uploaded_by_name
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.id = $1 AND d.uploaded_source = 'DMS'`,
    [req.params.id]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  try { doc.file_url = await getPlotDocUrl(doc.file_path); } catch { doc.file_url = null; }
  res.json(doc);
});

/** PATCH /documents/:id  → edit category/title/dates/metadata (JSON body). */
export const updateDmsDocument = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const sets = [];

  if (req.body.category !== undefined) sets.push(`category = ${add(normCategory(req.body.category))}`);
  if (req.body.title !== undefined) sets.push(`title = ${add(String(req.body.title).trim() || null)}`);
  if (req.body.doc_date !== undefined) sets.push(`doc_date = ${add(req.body.doc_date || null)}::date`);
  if (req.body.expiry_date !== undefined) sets.push(`expiry_date = ${add(req.body.expiry_date || null)}::date`);
  if (req.body.metadata !== undefined) sets.push(`metadata = ${add(JSON.stringify(req.body.metadata || {}))}::jsonb`);

  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  sets.push('updated_at = now()');

  const { rows } = await pool.query(
    `UPDATE documents SET ${sets.join(', ')}
      WHERE id = ${add(id)} AND uploaded_source = 'DMS'
      RETURNING id, category, title, doc_date, expiry_date, metadata`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Document not found' });
  res.json(rows[0]);
});

/** POST /documents/:id/retry-ocr  → re-download the stored file and OCR it again. */
export const retryOcr = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT id, file_path, mime_type FROM documents WHERE id = $1 AND uploaded_source = 'DMS'`,
    [id]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ message: 'Document not found' });
  if (!isOcrable(doc.mime_type)) return res.status(400).json({ message: 'This file type cannot be OCR-processed' });

  const url = await getPlotDocUrl(doc.file_path);
  const resp = await fetch(url);
  if (!resp.ok) return res.status(502).json({ message: 'Could not read the stored file for re-OCR' });
  const buffer = Buffer.from(await resp.arrayBuffer());

  await pool.query(`UPDATE documents SET ocr_status='PENDING', ocr_error=NULL, updated_at=now() WHERE id=$1`, [id]);
  res.json({ message: 'OCR restarted', id: Number(id) });

  processDmsOcr(Number(id), buffer, doc.mime_type);
});

/** DELETE /documents/:id  → remove the file + row. */
export const deleteDmsDocument = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(
    `SELECT id, file_path FROM documents WHERE id = $1 AND uploaded_source = 'DMS'`,
    [id]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ message: 'Document not found' });

  try { await deletePlotDoc(doc.file_path); } catch { /* best-effort file cleanup */ }
  await pool.query('DELETE FROM documents WHERE id = $1', [id]);
  res.json({ message: 'Document deleted', id: Number(id) });
});
