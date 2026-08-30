import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { uploadPlotDoc, getPlotDocUrl, deletePlotDoc } from '../utils/plotDocStorage.js';

/**
 * Document Imprest — register of physical documents handed over on site.
 *
 * Every issue is recorded with a camera photo taken at the moment of handover
 * (the proof), optionally an expected-return deadline, and later the return
 * with its own optional proof photo. Rows are the permanent history, scoped
 * to one site. Admins can work across sites; sub-admins can only access
 * records for sites assigned to them in user_sites. Each action stamps who did it.
 */

const S3_PREFIX = 'document_imprest';

const isAdminRole = (role) => role === 'admin' || role === 'super_admin';

const ensureSiteAccess = async (req, res, siteId) => {
  if (isAdminRole(req.user.role)) return true;

  const { rows } = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (rows[0]) return true;

  res.status(403).json({ message: 'Access denied to this site' });
  return false;
};

/** Resolve the record's authoritative site before exposing proof keys or mutating it. */
const getAccessibleRecord = async (req, res, id) => {
  const { rows } = await pool.query('SELECT * FROM document_imprest WHERE id = $1', [id]);
  const record = rows[0];
  if (!record) {
    res.status(404).json({ message: 'Record not found' });
    return null;
  }
  if (!await ensureSiteAccess(req, res, record.site_id)) return null;
  return record;
};

const getSiteReceiver = async (receiverUserId, siteId) => {
  const { rows } = await pool.query(
    `SELECT u.id
       FROM users u
      WHERE u.id = $1
        AND u.is_active = true
        AND (
          u.role IN ('admin', 'super_admin')
          OR EXISTS (
            SELECT 1 FROM user_sites us
             WHERE us.user_id = u.id AND us.site_id = $2
          )
        )
      LIMIT 1`,
    [receiverUserId, siteId]
  );
  return rows[0] || null;
};

// A cheque handed to someone can end up in one of these states. NULL = still with them.
export const CHEQUE_OUTCOMES = Object.freeze(['DEPOSITED', 'CLEARED', 'BOUNCED', 'RETURNED', 'CANCELLED', 'HANDED_ON']);
const ITEM_TYPES = Object.freeze(['DOCUMENT', 'CHEQUE']);
// Outcomes that mean the item is no longer out with the holder.
const CLOSING_OUTCOMES = new Set(['CLEARED', 'RETURNED', 'CANCELLED']);

/** Append to the record's trail — this is what answers "what happened to that cheque". */
const addEvent = async (db, imprestId, event, { notes = null, photoKey = null, userId = null } = {}) => {
  await db.query(
    `INSERT INTO document_imprest_events (imprest_id, event, notes, photo_key, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [imprestId, event, notes, photoKey, userId]
  );
};

const RECORD_SELECT = `
  SELECT di.*,
         iu.name  AS issued_by_name,   iu.email AS issued_by_email,
         ru.name  AS receiver_user_name, ru.email AS receiver_user_email,
         rb.name  AS return_received_by_name
    FROM document_imprest di
    LEFT JOIN users iu ON iu.id = di.issued_by
    LEFT JOIN users ru ON ru.id = di.receiver_user_id
    LEFT JOIN users rb ON rb.id = di.return_received_by
`;

/** Attach fresh signed URLs for the proof photos and strip raw storage keys. */
const withPhotoUrls = async (row) => {
  const r = { ...row };
  try { r.photo_url = await getPlotDocUrl(r.photo_key); } catch { r.photo_url = null; }
  try { r.return_photo_url = r.return_photo_key ? await getPlotDocUrl(r.return_photo_key) : null; } catch { r.return_photo_url = null; }
  try { r.outcome_photo_url = r.outcome_photo_key ? await getPlotDocUrl(r.outcome_photo_key) : null; } catch { r.outcome_photo_url = null; }
  delete r.photo_key;
  delete r.return_photo_key;
  delete r.outcome_photo_key;
  return r;
};

/**
 * GET /document-imprest?site_id=&status=&q=
 * Site-scoped register, newest first, plus summary counts for that site.
 * status: ISSUED | RETURNED | OVERDUE (overdue = still out past its deadline).
 */
export const listDocumentImprest = asyncHandler(async (req, res) => {
  const { status, q, site_id, item_type } = req.query;
  const siteId = parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required' });
  if (!await ensureSiteAccess(req, res, siteId)) return;

  const where = [];
  const params = [siteId];
  where.push('di.site_id = $1');

  if (ITEM_TYPES.includes(String(item_type || '').toUpperCase())) {
    params.push(String(item_type).toUpperCase());
    where.push(`di.item_type = $${params.length}`);
  }
  if (status === 'OVERDUE') {
    where.push(`di.status = 'ISSUED' AND di.expected_return_at IS NOT NULL AND di.expected_return_at < now()`);
  } else if (status === 'ISSUED' || status === 'RETURNED') {
    params.push(status);
    where.push(`di.status = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    const p = `$${params.length}`;
    where.push(`(di.document_name ILIKE ${p} OR di.receiver_name ILIKE ${p} OR ru.name ILIKE ${p} OR iu.name ILIKE ${p})`);
  }

  const { rows } = await pool.query(
    `${RECORD_SELECT}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY di.created_at DESC, di.id DESC
     LIMIT 500`,
    params
  );

  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE status = 'ISSUED')::int   AS issued,
           COUNT(*) FILTER (WHERE status = 'RETURNED')::int AS returned,
           COUNT(*) FILTER (WHERE status = 'ISSUED' AND expected_return_at IS NOT NULL AND expected_return_at < now())::int AS overdue
      FROM document_imprest
     WHERE site_id = $1
  `, [siteId]);

  res.json({ records: await Promise.all(rows.map(withPhotoUrls)), stats });
});

/**
 * POST /document-imprest  (multipart)
 * Record a handover. Requires: document_name + photo (the camera proof).
 * Receiver is a system user (receiver_user_id) or a free-text name (receiver_name).
 * expected_return_at (ISO string) is optional — absent means open-ended.
 */
export const createDocumentImprest = asyncHandler(async (req, res) => {
  const { document_name, description, receiver_user_id, receiver_name, expected_return_at, remarks, site_id } = req.body;
  const itemType = ITEM_TYPES.includes(String(req.body.item_type || '').toUpperCase())
    ? String(req.body.item_type).toUpperCase()
    : 'DOCUMENT';
  const isCheque = itemType === 'CHEQUE';
  const chequeNo = req.body.cheque_no ? String(req.body.cheque_no).trim() : null;
  const chequeAmount = req.body.cheque_amount === undefined || req.body.cheque_amount === null || req.body.cheque_amount === ''
    ? null
    : Number(req.body.cheque_amount);
  if (isCheque) {
    if (!chequeNo) return res.status(400).json({ message: 'Cheque number is required' });
    if (chequeAmount !== null && !(Number.isFinite(chequeAmount) && chequeAmount > 0)) {
      return res.status(400).json({ message: 'Cheque amount must be greater than zero' });
    }
  }

  if (!document_name || !String(document_name).trim()) {
    return res.status(400).json({ message: 'Document name is required' });
  }
  if (!req.file) {
    return res.status(400).json({ message: 'A handover photo is required as proof' });
  }
  const siteId = parseInt(site_id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) return res.status(400).json({ message: 'A valid site_id is required' });
  const { rows: siteRows } = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
  if (!siteRows[0]) return res.status(400).json({ message: 'Site not found' });
  if (!await ensureSiteAccess(req, res, siteId)) return;

  let receiverUserId = null;
  if (receiver_user_id) {
    receiverUserId = parseInt(receiver_user_id, 10);
    if (Number.isNaN(receiverUserId)) return res.status(400).json({ message: 'Invalid receiver_user_id' });
    if (!await getSiteReceiver(receiverUserId, siteId)) {
      return res.status(400).json({ message: 'Receiver is not available for this site' });
    }
  }
  const receiverName = receiver_name && String(receiver_name).trim() ? String(receiver_name).trim() : null;
  if (!receiverUserId && !receiverName) {
    return res.status(400).json({ message: 'Select a receiver or enter the receiver name' });
  }

  let expectedReturnAt = null;
  if (expected_return_at) {
    expectedReturnAt = new Date(expected_return_at);
    if (Number.isNaN(expectedReturnAt.getTime())) return res.status(400).json({ message: 'Invalid expected return time' });
  }

  let photoKey = null;
  let photoPersisted = false;
  try {
    photoKey = await uploadPlotDoc(req.file.buffer, req.file.originalname || 'handover.jpg', req.file.mimetype, S3_PREFIX);

    const { rows: [created] } = await pool.query(
      `INSERT INTO document_imprest
         (document_name, description, receiver_user_id, receiver_name, issued_by, photo_key, expected_return_at, remarks, site_id,
          item_type, cheque_no, bank_name, cheque_amount, cheque_date, payee_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [String(document_name).trim(), description || null, receiverUserId, receiverName, req.user.id, photoKey, expectedReturnAt, remarks || null, siteId,
        itemType,
        isCheque ? chequeNo : null,
        isCheque && req.body.bank_name ? String(req.body.bank_name).trim().toUpperCase() : null,
        isCheque ? chequeAmount : null,
        isCheque && req.body.cheque_date ? req.body.cheque_date : null,
        isCheque && req.body.payee_name ? String(req.body.payee_name).trim().toUpperCase() : null]
    );
    photoPersisted = true;
    await addEvent(pool, created.id, 'HANDED_OVER', { notes: remarks || null, photoKey, userId: req.user.id });

    const { rows } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [created.id]);
    res.status(201).json({ record: await withPhotoUrls(rows[0]) });
  } catch (error) {
    if (photoKey && !photoPersisted) await deletePlotDoc(photoKey).catch(() => {});
    throw error;
  }
});

/**
 * PUT /document-imprest/:id
 * Edit a record's details (name, description, receiver, deadline, remarks).
 * The handover proof photo is immutable — that's the point of it.
 * Gated by the document_imprest `update` permission at the route.
 */
export const updateDocumentImprest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const existing = await getAccessibleRecord(req, res, id);
  if (!existing) return;

  const { document_name, description, receiver_user_id, receiver_name, expected_return_at, remarks } = req.body;

  if (!document_name || !String(document_name).trim()) {
    return res.status(400).json({ message: 'Document name is required' });
  }

  let receiverUserId = null;
  if (receiver_user_id) {
    receiverUserId = parseInt(receiver_user_id, 10);
    if (Number.isNaN(receiverUserId)) return res.status(400).json({ message: 'Invalid receiver_user_id' });
    if (!await getSiteReceiver(receiverUserId, existing.site_id)) {
      return res.status(400).json({ message: 'Receiver is not available for this site' });
    }
  }
  const receiverName = receiver_name && String(receiver_name).trim() ? String(receiver_name).trim() : null;
  if (!receiverUserId && !receiverName) {
    return res.status(400).json({ message: 'Select a receiver or enter the receiver name' });
  }

  let expectedReturnAt = null;
  if (expected_return_at) {
    expectedReturnAt = new Date(expected_return_at);
    if (Number.isNaN(expectedReturnAt.getTime())) return res.status(400).json({ message: 'Invalid expected return time' });
  }

  await pool.query(
    `UPDATE document_imprest
        SET document_name = $2, description = $3, receiver_user_id = $4,
            receiver_name = $5, expected_return_at = $6, remarks = $7
      WHERE id = $1`,
    [id, String(document_name).trim(), description || null, receiverUserId, receiverName, expectedReturnAt, remarks || null]
  );

  const { rows } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [id]);
  res.json({ record: await withPhotoUrls(rows[0]) });
});

/**
 * DELETE /document-imprest/:id
 * Remove a record while retaining its proof photos for recycle recovery.
 * Gated by the document_imprest `delete` permission at the route —
 * admins only unless a sub-admin is explicitly granted delete.
 */
export const deleteDocumentImprest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const record = await getAccessibleRecord(req, res, id);
  if (!record) return;

  await pool.query('DELETE FROM document_imprest WHERE id = $1', [id]);

  res.json({ message: 'Record deleted' });
});

/**
 * POST /document-imprest/:id/return  (multipart)
 * Mark a document as returned. Photo proof and remarks are optional here —
 * the mandatory proof was captured at handover.
 */
export const returnDocumentImprest = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const existing = await getAccessibleRecord(req, res, id);
  if (!existing) return;
  if (existing.status === 'RETURNED') return res.status(409).json({ message: 'Document is already marked returned' });

  let returnPhotoKey = null;
  let returnPhotoPersisted = false;
  try {
    if (req.file) {
      returnPhotoKey = await uploadPlotDoc(req.file.buffer, req.file.originalname || 'return.jpg', req.file.mimetype, S3_PREFIX);
    }

    const { rows: transitionedRows } = await pool.query(
      `UPDATE document_imprest
          SET status = 'RETURNED', returned_at = now(),
              return_photo_key = $2, return_received_by = $3, return_remarks = $4
        WHERE id = $1
          AND status = 'ISSUED'
        RETURNING id`,
      [id, returnPhotoKey, req.user.id, req.body.return_remarks || null]
    );
    if (rows[0]) await addEvent(pool, id, 'RETURNED', { notes: req.body.return_remarks || null, photoKey: returnPhotoKey, userId: req.user.id });

    // Another authorized request may have returned the document after our
    // initial access check but before this write. Never overwrite that audit
    // event, and remove any proof object uploaded by the losing request.
    if (!transitionedRows[0]) {
      if (returnPhotoKey) {
        try {
          await deletePlotDoc(returnPhotoKey);
        } catch (cleanupError) {
          console.error(`Document imprest ${id} losing return proof cleanup failed:`, cleanupError.message);
        }
        returnPhotoKey = null;
      }
      return res.status(409).json({ message: 'Document is already marked returned' });
    }
    returnPhotoPersisted = true;

    const { rows } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [id]);
    res.json({ record: await withPhotoUrls(rows[0]) });
  } catch (error) {
    if (returnPhotoKey && !returnPhotoPersisted) await deletePlotDoc(returnPhotoKey).catch(() => {});
    throw error;
  }
});

/**
 * POST /document-imprest/:id/outcome
 * Record what happened to a handed-over cheque: deposited, cleared, bounced, returned,
 * cancelled, or passed on to someone else. Each call appends to the record's trail, so
 * the full story stays visible instead of a single field being overwritten.
 * Body: { outcome, notes? } + optional `photo` file.
 */
export const recordChequeOutcome = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const outcome = String(req.body.outcome || '').trim().toUpperCase();
  if (!CHEQUE_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ message: `Outcome must be one of: ${CHEQUE_OUTCOMES.join(', ')}` });
  }

  const existing = await getAccessibleRecord(req, res, id);
  if (!existing) return;
  if (existing.item_type !== 'CHEQUE') {
    return res.status(400).json({ message: 'Only a cheque handover can record a cheque outcome' });
  }

  let photoKey = null;
  try {
    if (req.file) {
      photoKey = await uploadPlotDoc(req.file.buffer, req.file.originalname || 'outcome.jpg', req.file.mimetype, S3_PREFIX);
    }
    const notes = req.body.notes ? String(req.body.notes).trim() : null;
    // A closing outcome also ends the handover; DEPOSITED / BOUNCED / HANDED_ON leave it open,
    // because the cheque is still out there and more can still happen to it.
    const closes = CLOSING_OUTCOMES.has(outcome);
    const { rows } = await pool.query(
      `UPDATE document_imprest
          SET outcome = $2, outcome_at = now(), outcome_by = $3,
              outcome_remarks = $4, outcome_photo_key = COALESCE($5, outcome_photo_key),
              status = CASE WHEN $6::boolean THEN 'RETURNED' ELSE status END,
              returned_at = CASE WHEN $6::boolean THEN COALESCE(returned_at, now()) ELSE returned_at END
        WHERE id = $1
        RETURNING id`,
      [id, outcome, req.user.id, notes, photoKey, closes]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Record not found' });

    await addEvent(pool, id, outcome, { notes, photoKey, userId: req.user.id });
    const { rows: fresh } = await pool.query(`${RECORD_SELECT} WHERE di.id = $1`, [id]);
    res.json({ record: await withPhotoUrls(fresh[0]), message: `Cheque marked ${outcome.toLowerCase().replace('_', ' ')}` });
  } catch (error) {
    if (photoKey) await deletePlotDoc(photoKey).catch(() => {});
    throw error;
  }
});

/** GET /document-imprest/:id/events — the handover trail, oldest first. */
export const listImprestEvents = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });
  const existing = await getAccessibleRecord(req, res, id);
  if (!existing) return;

  const { rows } = await pool.query(
    `SELECT e.id, e.event, e.notes, e.photo_key, e.created_at,
            COALESCE(u.name, u.email) AS created_by_name
       FROM document_imprest_events e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.imprest_id = $1
      ORDER BY e.created_at ASC, e.id ASC`,
    [id]
  );
  const events = await Promise.all(rows.map(async (row) => {
    const out = { ...row };
    try { out.photo_url = row.photo_key ? await getPlotDocUrl(row.photo_key) : null; } catch { out.photo_url = null; }
    delete out.photo_key;
    return out;
  }));
  res.json({ events });
});
