import path from 'path';
import { randomUUID } from 'crypto';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import permissionModel from '../models/Permission.model.js';
import {
  deletePlotDoc, getPlotDocBytes, getPlotDocUrl, uploadPlotDoc,
} from '../utils/plotDocStorage.js';
import { isOcrable, runDmsOcr } from '../services/dmsOcr.service.js';
import {
  assertComplianceSiteAccess, getScopedComplianceEntity, isOrgAdmin, parsePositiveId,
  writeComplianceAudit,
} from '../utils/complianceAccess.js';

// ponytail: the source app also attaches evidence to other modules' records;
// this install keeps the five compliance entities. The empty sets keep the
// shared flow verbatim.
const ENTITY = Object.freeze({
  COMPLIANCE: { table: 'compliance_items', module: 'compliance' },
  LICENCE: { table: 'compliance_licences', module: 'compliance' },
  LEGAL_CASE: { table: 'legal_cases', module: 'legal' },
  LEGAL_NOTICE: { table: 'legal_notices', module: 'legal' },
  INSPECTION: { table: 'compliance_inspections', module: 'compliance' },
});
const SITE_SCOPED_ENTITY_TYPES = new Set([]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_TYPES = new Set(['USER_UPLOADED', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT', 'IMPORTED', 'OTHER']);
const REVIEW_STATUSES = new Set(['NOT_REVIEWED', 'PENDING', 'ACCEPTED', 'REJECTED']);
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const normalizedType = (value) => String(value || '').trim().toUpperCase();
const validDate = (value) => {
  if (!value) return true;
  const raw = String(value);
  if (!DATE_RE.test(raw)) return false;
  const [year, month, day] = raw.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
};

async function requireEntity(req, res, rawType, rawId, action = 'read') {
  const entityType = normalizedType(rawType);
  const config = ENTITY[entityType];
  const entityId = parsePositiveId(rawId);
  if (!config || !entityId) {
    res.status(400).json({ message: 'Invalid compliance document entity' });
    return null;
  }
  if (!isOrgAdmin(req.user)) {
    const permission = await permissionModel.getPermission(req.user.id, config.module);
    if (permission?.[`can_${action}`] !== true) {
      res.status(403).json({ message: `${action} access to ${config.module} is required` });
      return null;
    }
  }
  const entity = config.resolver
    ? await config.resolver(req, res, entityId)
    : await getScopedComplianceEntity(req, config.table, entityId);
  if (res.headersSent) return null;
  if (!entity) {
    res.status(404).json({ message: 'Related record not found' });
    return null;
  }

  const entitySiteId = entity.site_id || req.siteContextId || null;
  if (SITE_SCOPED_ENTITY_TYPES.has(entityType) && !entitySiteId) {
    res.status(400).json({
      code: 'SITE_CONTEXT_REQUIRED',
      message: 'Select a Site before using regulatory evidence',
    });
    return null;
  }
  if (req.siteContextId && entitySiteId && Number(req.siteContextId) !== Number(entitySiteId)) {
    res.status(409).json({ message: 'Selected site does not match the document record' });
    return null;
  }
  return { entityType, entityId, entity, config };
}

const validHttpUrl = (value) => {
  if (!value) return true;
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
};

const toPublic = async (row) => {
  const result = { ...row };
  const localPrivateEvidence = String(result.storage_key || '').startsWith('local-private::');
  result.file_url = localPrivateEvidence ? null : await getPlotDocUrl(result.storage_key);
  result.content_url = localPrivateEvidence
    ? `/compliance-documents/file/${result.id}/content`
    : null;
  delete result.storage_key;
  delete result.ocr_text;
  return result;
};

async function processOcr(documentId, buffer, mime) {
  if (!isOcrable(mime)) {
    await pool.query(`UPDATE compliance_documents SET ocr_status='NOT_SUPPORTED' WHERE id=$1`, [documentId]);
    return;
  }
  try {
    await pool.query(`UPDATE compliance_documents SET ocr_status='PROCESSING' WHERE id=$1`, [documentId]);
    const { text } = await runDmsOcr(buffer, mime);
    await pool.query(`UPDATE compliance_documents SET ocr_status='DONE',ocr_text=$1,ocr_error=NULL WHERE id=$2`, [text, documentId]);
  } catch (error) {
    await pool.query(`UPDATE compliance_documents SET ocr_status='FAILED',ocr_error=$1 WHERE id=$2`, [String(error.message || error).slice(0, 2000), documentId]).catch(() => {});
  }
}

export const uploadComplianceDocument = asyncHandler(async (req, res) => {
  const context = await requireEntity(req, res, req.params.entityType, req.params.entityId, 'write');
  if (!context) return;
  if (!req.file?.buffer?.length) return res.status(400).json({ message: 'Select a non-empty document' });
  const suppliedMime = String(req.file.mimetype || '').toLowerCase();
  if (!ALLOWED_MIME.has(suppliedMime)) return res.status(400).json({ message: 'Unsupported document type' });
  if (!validDate(req.body.issue_date) || !validDate(req.body.effective_date) || !validDate(req.body.expiry_date)) {
    return res.status(400).json({ message: 'Issue, effective and expiry dates must use YYYY-MM-DD' });
  }
  if (req.body.issue_date && req.body.expiry_date && req.body.expiry_date < req.body.issue_date) {
    return res.status(400).json({ message: 'Expiry date cannot be before issue date' });
  }
  if (!validHttpUrl(req.body.source_url)) {
    return res.status(400).json({ message: 'Source URL must use http or https' });
  }
  const confidentiality = String(req.body.confidentiality || 'INTERNAL').toUpperCase();
  if (confidentiality === 'RESTRICTED' && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'Only administrators can upload restricted evidence' });
  }
  const sourceType = String(req.body.source_type || 'USER_UPLOADED').toUpperCase();
  if (!SOURCE_TYPES.has(sourceType)) return res.status(400).json({ message: 'Invalid evidence source type' });
  const reviewStatus = String(req.body.review_status || 'NOT_REVIEWED').toUpperCase();
  if (!REVIEW_STATUSES.has(reviewStatus)) return res.status(400).json({ message: 'Invalid evidence review status' });
  if (['ACCEPTED', 'REJECTED'].includes(reviewStatus) && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'Only administrators can record an evidence review decision' });
  }
  const suppliedSupersedes = req.body.supersedes_document_id;
  const supersedesDocumentId = suppliedSupersedes ? parsePositiveId(suppliedSupersedes) : null;
  if (suppliedSupersedes && !supersedesDocumentId) {
    return res.status(400).json({ message: 'Invalid superseded document reference' });
  }
  const title = String(req.body.title || path.parse(req.file.originalname).name || 'Evidence').trim().slice(0, 300);
  const category = String(req.body.category || 'OTHER').trim().toUpperCase().slice(0, 120);
  const evidenceSiteId = context.entity.site_id || req.siteContextId;
  const storageKey = await uploadPlotDoc(
    req.file.buffer, req.file.originalname, suppliedMime,
    `compliance/${req.user.organization_id}/${context.entityType.toLowerCase()}`
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let supersededDocument = null;
    if (supersedesDocumentId) {
      const { rows: supersededRows } = await client.query(
        `SELECT id,title,superseded_at,document_series_key
          FROM compliance_documents
          WHERE id=$1 AND organization_id=$2 AND entity_type=$3 AND entity_id=$4
            AND site_id IS NOT DISTINCT FROM $5 AND deleted_at IS NULL
          LIMIT 1 FOR UPDATE`,
        [
          supersedesDocumentId, req.user.organization_id, context.entityType,
          context.entityId, evidenceSiteId,
        ]
      );
      supersededDocument = supersededRows[0] || null;
      if (!supersededDocument) {
        await client.query('ROLLBACK');
        await deletePlotDoc(storageKey).catch(() => {});
        return res.status(400).json({ message: 'Superseded evidence was not found in this record' });
      }
      if (supersededDocument.superseded_at) {
        await client.query('ROLLBACK');
        await deletePlotDoc(storageKey).catch(() => {});
        return res.status(409).json({ message: 'That evidence version has already been superseded' });
      }
    }

    const documentSeriesKey = supersededDocument?.document_series_key
      || (supersededDocument ? `legacy-${supersededDocument.id}` : randomUUID());
    if (supersededDocument && !supersededDocument.document_series_key) {
      await client.query(
        `UPDATE compliance_documents SET document_series_key=$1
          WHERE id=$2 AND organization_id=$3 AND site_id IS NOT DISTINCT FROM $4
            AND document_series_key IS NULL`,
        [documentSeriesKey, supersededDocument.id, req.user.organization_id, evidenceSiteId]
      );
      supersededDocument.document_series_key = documentSeriesKey;
    }
    // The transaction-level lock serializes version allocation for this stable
    // series even if callers race on different application workers.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${req.user.organization_id}:${evidenceSiteId}:${context.entityType}:${context.entityId}:${documentSeriesKey}`]
    );
    const { rows: versionRows } = await client.query(
      `SELECT COALESCE(MAX(version_no),0)+1 AS next_version
         FROM compliance_documents
        WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3
          AND site_id IS NOT DISTINCT FROM $4 AND document_series_key=$5`,
      [req.user.organization_id, context.entityType, context.entityId, evidenceSiteId, documentSeriesKey]
    );
    const nextVersion = Number(versionRows[0]?.next_version || 1);
    const reviewed = ['ACCEPTED', 'REJECTED'].includes(reviewStatus);
    const { rows } = await client.query(
      `INSERT INTO compliance_documents
        (organization_id,site_id,entity_type,entity_id,category,title,original_name,storage_key,
         mime_type,file_size,document_series_key,version_no,tags,verification_status,approval_status,confidentiality,
         issue_date,effective_date,expiry_date,issuing_authority,document_type,document_number,
         source_type,source_reference,source_url,source_retrieved_at,review_status,reviewed_by,
         reviewed_at,review_notes,supersedes_document_id,uploaded_by)
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32
       ) RETURNING *`,
      [
        req.user.organization_id, evidenceSiteId,
        context.entityType, context.entityId,
        category, title, String(req.file.originalname).slice(0, 500), storageKey, suppliedMime,
        req.file.size || req.file.buffer.length, documentSeriesKey, nextVersion,
        Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || '').split(',').map((v) => v.trim()).filter(Boolean),
        String(req.body.verification_status || 'UNVERIFIED').toUpperCase(),
        String(req.body.approval_status || 'NOT_REQUIRED').toUpperCase(),
        ['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED'].includes(confidentiality) ? confidentiality : 'INTERNAL',
        req.body.issue_date || null, req.body.effective_date || null, req.body.expiry_date || null,
        String(req.body.issuing_authority || '').trim().slice(0, 300) || null,
        String(req.body.document_type || category).trim().slice(0, 120) || null,
        String(req.body.document_number || '').trim().slice(0, 200) || null,
        sourceType,
        String(req.body.source_reference || '').trim().slice(0, 2000) || null,
        String(req.body.source_url || '').trim().slice(0, 2000) || null,
        req.body.source_url ? new Date() : null,
        reviewStatus, reviewed ? req.user.id : null, reviewed ? new Date() : null,
        String(req.body.review_notes || '').trim().slice(0, 4000) || null,
        supersedesDocumentId, req.user.id,
      ]
    );
    if (supersedesDocumentId) {
      const { rows: supersededUpdateRows } = await client.query(
        `UPDATE compliance_documents
            SET superseded_at=NOW(),superseded_by=$1
          WHERE id=$2 AND organization_id=$3 AND site_id IS NOT DISTINCT FROM $4
            AND entity_type=$5 AND entity_id=$6 AND superseded_at IS NULL
          RETURNING id`,
        [
          req.user.id, supersedesDocumentId, req.user.organization_id,
          evidenceSiteId, context.entityType, context.entityId,
        ]
      );
      if (!supersededUpdateRows[0]) {
        throw new Error('Superseded evidence changed before the new version was committed');
      }
    }
    await writeComplianceAudit(client, req, {
      action: 'DOCUMENT_UPLOAD', entityType: context.entityType, entityId: context.entityId,
      siteId: context.entity.site_id || req.siteContextId,
      previousValue: supersededDocument,
      newValue: {
        document_id: rows[0].id, title, category, confidentiality,
        supersedes_document_id: supersedesDocumentId,
      },
    });
    await client.query('COMMIT');
    void processOcr(rows[0].id, req.file.buffer, suppliedMime);
    res.status(201).json({ document: await toPublic(rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await deletePlotDoc(storageKey).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

export const listComplianceDocuments = asyncHandler(async (req, res) => {
  const context = await requireEntity(req, res, req.params.entityType, req.params.entityId);
  if (!context) return;
  const params = [req.user.organization_id, context.entityType, context.entityId];
  let siteScope = '';
  if (SITE_SCOPED_ENTITY_TYPES.has(context.entityType)) {
    params.push(context.entity.site_id || req.siteContextId);
    siteScope = `AND d.site_id=$${params.length}`;
  }
  let search = '';
  if (req.query.q) {
    params.push(String(req.query.q).trim().slice(0, 100));
    search = `AND (
      d.title ILIKE '%' || $${params.length} || '%'
      OR d.original_name ILIKE '%' || $${params.length} || '%'
      OR to_tsvector('simple',COALESCE(d.ocr_text,'')) @@ plainto_tsquery('simple',$${params.length})
    )`;
  }
  const confidentiality = isOrgAdmin(req.user) ? '' : `AND d.confidentiality <> 'RESTRICTED'`;
  const { rows } = await pool.query(
    `SELECT d.id,d.category,d.title,d.original_name,d.mime_type,d.file_size,d.version_no,d.ocr_status,
            d.tags,d.verification_status,d.approval_status,d.confidentiality,d.issue_date,d.expiry_date,
            d.effective_date,d.issuing_authority,d.document_type,d.document_number,
            d.source_type,d.source_reference,d.source_url,d.source_retrieved_at,
            d.review_status,d.reviewed_by,d.reviewed_at,d.review_notes,
            d.supersedes_document_id,d.superseded_at,
            d.uploaded_by,u.name AS uploaded_by_name,d.created_at
       FROM compliance_documents d
      LEFT JOIN users u ON u.id=d.uploaded_by
      WHERE d.organization_id=$1 AND d.entity_type=$2 AND d.entity_id=$3
        AND d.deleted_at IS NULL ${siteScope} ${confidentiality} ${search}
      ORDER BY d.created_at DESC`,
    params
  );
  res.json({ documents: rows });
});

/** Tenant- and site-scoped document-expiry register across all compliance entities. */
export const listExpiringComplianceDocuments = asyncHandler(async (req, res) => {
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 25, 1), 100);
  const params = [req.user.organization_id];
  const where = ['d.organization_id=$1', 'd.deleted_at IS NULL', 'd.expiry_date IS NOT NULL'];

  const requestedEntityType = req.query.entity_type
    ? normalizedType(req.query.entity_type)
    : null;
  if (!isOrgAdmin(req.user)) {
    const legalPermission = await permissionModel.getPermission(req.user.id, 'legal');
    if (legalPermission?.can_read !== true) {
      where.push(`d.entity_type NOT IN ('LEGAL_CASE','LEGAL_NOTICE')`);
    }
  }
  if (!isOrgAdmin(req.user)) {
    params.push(req.user.id);
    where.push(`d.site_id IN (SELECT us.site_id FROM user_sites us WHERE us.user_id=$${params.length})`);
    where.push(`d.confidentiality <> 'RESTRICTED'`);
  }
  if (req.query.site_id) {
    const siteId = await assertComplianceSiteAccess(req, res, req.query.site_id);
    if (siteId === false) return;
    params.push(siteId);
    where.push(`d.site_id=$${params.length}`);
  }
  if (req.query.from) {
    if (!validDate(req.query.from)) return res.status(400).json({ message: 'Invalid from date' });
    params.push(req.query.from);
    where.push(`d.expiry_date >= $${params.length}`);
  }
  if (req.query.to) {
    if (!validDate(req.query.to)) return res.status(400).json({ message: 'Invalid to date' });
    params.push(req.query.to);
    where.push(`d.expiry_date <= $${params.length}`);
  }
  if (req.query.entity_type) {
    const entityType = requestedEntityType;
    if (!ENTITY[entityType]) return res.status(400).json({ message: 'Invalid entity type' });
    params.push(entityType);
    where.push(`d.entity_type=$${params.length}`);
  }
  if (req.query.q) {
    params.push(String(req.query.q).trim().slice(0, 100));
    where.push(`(
      d.title ILIKE '%' || $${params.length} || '%'
      OR d.original_name ILIKE '%' || $${params.length} || '%'
      OR d.issuing_authority ILIKE '%' || $${params.length} || '%'
    )`);
  }
  const clause = where.join(' AND ');
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM compliance_documents d WHERE ${clause}`,
    params
  );
  params.push(limit, (page - 1) * limit);
  const { rows } = await pool.query(
    `SELECT d.id,d.site_id,d.entity_type,d.entity_id,d.category,d.title,d.original_name,
            d.mime_type,d.file_size,d.version_no,d.verification_status,d.confidentiality,
            d.issue_date,d.effective_date,d.expiry_date,d.issuing_authority,d.document_type,
            d.document_number,d.source_type,d.source_reference,d.source_url,d.review_status,
            d.superseded_at,d.created_at,
            s.name AS site_name,u.name AS uploaded_by_name,
            (d.expiry_date-CURRENT_DATE)::int AS days_remaining
       FROM compliance_documents d
       LEFT JOIN sites s ON s.id=d.site_id AND s.organization_id=d.organization_id
       LEFT JOIN users u ON u.id=d.uploaded_by AND u.organization_id=d.organization_id
      WHERE ${clause}
      ORDER BY d.expiry_date ASC,d.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const total = countRows[0]?.total || 0;
  res.json({ documents: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

export const getComplianceDocument = asyncHandler(async (req, res) => {
  const documentId = parsePositiveId(req.params.documentId);
  const { rows } = await pool.query(
    `SELECT * FROM compliance_documents WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [documentId, req.user.organization_id]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found' });
  const context = await requireEntity(req, res, document.entity_type, document.entity_id);
  if (!context) return;
  if (SITE_SCOPED_ENTITY_TYPES.has(document.entity_type)
      && Number(document.site_id) !== Number(context.entity.site_id || req.siteContextId)) {
    return res.status(404).json({ message: 'Document not found for the selected Site' });
  }
  if (document.confidentiality === 'RESTRICTED' && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'Restricted document access denied' });
  }
  await writeComplianceAudit(pool, req, {
    action: 'DOCUMENT_DOWNLOAD', entityType: document.entity_type, entityId: document.entity_id,
    siteId: document.site_id, newValue: { document_id: document.id, title: document.title },
  });
  res.json({ document: await toPublic(document) });
});

/** Authenticated byte stream used by private local regulatory evidence. */
export const streamComplianceDocument = asyncHandler(async (req, res) => {
  const documentId = parsePositiveId(req.params.documentId);
  if (!documentId) return res.status(400).json({ message: 'Invalid document id' });
  const { rows } = await pool.query(
    `SELECT * FROM compliance_documents
      WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [documentId, req.user.organization_id]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found' });
  const context = await requireEntity(req, res, document.entity_type, document.entity_id);
  if (!context) return;
  if (SITE_SCOPED_ENTITY_TYPES.has(document.entity_type)
      && Number(document.site_id) !== Number(context.entity.site_id || req.siteContextId)) {
    return res.status(404).json({ message: 'Document not found for the selected Site' });
  }
  if (document.confidentiality === 'RESTRICTED' && !isOrgAdmin(req.user)) {
    return res.status(403).json({ message: 'Restricted document access denied' });
  }

  const bytes = await getPlotDocBytes(document.storage_key);
  await writeComplianceAudit(pool, req, {
    action: 'DOCUMENT_DOWNLOAD', entityType: document.entity_type, entityId: document.entity_id,
    siteId: document.site_id, newValue: { document_id: document.id, title: document.title },
  });
  const safeName = String(document.original_name || document.title || `document-${document.id}`)
    .replace(/[\r\n]/g, ' ')
    .slice(0, 300);
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Type': document.mime_type || 'application/octet-stream',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(bytes);
});

export const deleteComplianceDocument = asyncHandler(async (req, res) => {
  const documentId = parsePositiveId(req.params.documentId);
  if (!documentId) return res.status(400).json({ message: 'Invalid document id' });
  const { rows } = await pool.query(
    `SELECT * FROM compliance_documents WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [documentId, req.user.organization_id]
  );
  const document = rows[0];
  if (!document) return res.status(404).json({ message: 'Document not found' });
  const context = await requireEntity(req, res, document.entity_type, document.entity_id, 'delete');
  if (!context) return;
  if (SITE_SCOPED_ENTITY_TYPES.has(document.entity_type)
      && Number(document.site_id) !== Number(context.entity.site_id || req.siteContextId)) {
    return res.status(404).json({ message: 'Document not found for the selected Site' });
  }
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'A deletion reason is required' });
  const client = await pool.connect();
  let deletedDocument;
  try {
    await client.query('BEGIN');
    const { rows: lockedRows } = await client.query(
      `SELECT * FROM compliance_documents
        WHERE id=$1 AND organization_id=$2 AND site_id IS NOT DISTINCT FROM $3
          AND entity_type=$4 AND entity_id=$5 AND deleted_at IS NULL
        LIMIT 1 FOR UPDATE`,
      [documentId, req.user.organization_id, document.site_id, document.entity_type, document.entity_id]
    );
    if (!lockedRows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'Document changed before it could be removed' });
    }
    const { rows: deletedRows } = await client.query(
      `UPDATE compliance_documents SET deleted_at=NOW()
        WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL RETURNING *`,
      [documentId, req.user.organization_id]
    );
    deletedDocument = deletedRows[0];
    if (!deletedDocument) throw new Error('Compliance document delete did not update a row');
    await writeComplianceAudit(client, req, {
      action: 'DOCUMENT_DELETE', entityType: deletedDocument.entity_type, entityId: deletedDocument.entity_id,
      siteId: deletedDocument.site_id,
      previousValue: { document_id: deletedDocument.id, title: deletedDocument.title }, reason,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  // Keep every attachment while its soft-deleted row remains recoverable.
  res.json({ success: true });
});
