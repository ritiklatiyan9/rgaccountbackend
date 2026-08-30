import crypto from 'crypto';
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { writeAuditLog } from '../services/auditLog.service.js';

const cleanModule = (value) => {
  const module = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 80);
  return module || null;
};

const cleanRecordId = (value) => {
  const recordId = String(value ?? '').trim().slice(0, 120);
  return recordId || null;
};

const cleanUrl = (value) => {
  const url = String(value || '').trim();
  return /^(https?:\/\/|\/)/i.test(url) ? url.slice(0, 4000) : null;
};

const positiveSiteId = (value) => {
  const siteId = Number.parseInt(value, 10);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
};

const assertSiteAccess = async (req, siteId, db = pool) => {
  if (!siteId || req.user.role === 'admin') return;
  const { rowCount } = await db.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (!rowCount) {
    const error = new Error('You do not have access to this site');
    error.statusCode = 403;
    throw error;
  }
};

const historyForReceipt = async (receiptId, db = pool) => {
  const { rows } = await db.query(
    `SELECT p.id, p.print_number, p.watermark, p.printed_at, p.preview_print,
            p.route_path, p.metadata, p.printed_by,
            COALESCE(u.name, CASE WHEN p.printed_by IS NULL THEN 'System' ELSE 'Deleted user #' || p.printed_by END) AS printed_by_name,
            u.email AS printed_by_email, u.photo AS printed_by_photo
       FROM transaction_receipt_prints p
       LEFT JOIN users u ON u.id = p.printed_by
      WHERE p.receipt_id = $1
      ORDER BY p.print_number DESC`,
    [receiptId]
  );
  return rows;
};

export const recordReceiptPrint = asyncHandler(async (req, res) => {
  const module = cleanModule(req.body.module);
  const recordId = cleanRecordId(req.body.record_id);
  const siteId = positiveSiteId(req.body.site_id);
  if (!module || !recordId) return res.status(400).json({ message: 'module and record_id are required' });

  await assertSiteAccess(req, siteId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`receipt-print:${req.user.organization_id || 1}:${module}:${recordId}`]);

    const receiptResult = await client.query(
      `INSERT INTO transaction_receipts (
         organization_id, site_id, module, record_id,
         customer_signature_url, authority_signature_url, evidence_photo_url, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (organization_id, module, record_id) DO UPDATE SET
         site_id = COALESCE(EXCLUDED.site_id, transaction_receipts.site_id),
         customer_signature_url = COALESCE(EXCLUDED.customer_signature_url, transaction_receipts.customer_signature_url),
         authority_signature_url = COALESCE(EXCLUDED.authority_signature_url, transaction_receipts.authority_signature_url),
         evidence_photo_url = COALESCE(EXCLUDED.evidence_photo_url, transaction_receipts.evidence_photo_url),
         updated_at = NOW()
       RETURNING *`,
      [
        Number(req.user.organization_id) || 1,
        siteId,
        module,
        recordId,
        cleanUrl(req.body.customer_signature_url),
        cleanUrl(req.body.authority_signature_url),
        cleanUrl(req.body.evidence_photo_url),
        req.user.id,
      ]
    );
    const receipt = receiptResult.rows[0];
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM transaction_receipt_prints WHERE receipt_id = $1',
      [receipt.id]
    );
    const printNumber = Number(countResult.rows[0]?.count || 0) + 1;
    const watermark = printNumber === 1 ? 'ORIGINAL' : 'DUPLICATE';
    const suppliedPrintedAt = req.body.printed_at && !Number.isNaN(Date.parse(req.body.printed_at))
      ? new Date(req.body.printed_at)
      : new Date();
    const workflowId = String(req.body.workflow_id || '').trim();

    const printResult = await client.query(
      `INSERT INTO transaction_receipt_prints (
         receipt_id, print_number, watermark, printed_by, printed_at,
         preview_print, workflow_id, route_path, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        receipt.id,
        printNumber,
        watermark,
        req.user.id,
        suppliedPrintedAt,
        req.body.preview_print === true,
        /^[0-9a-f-]{36}$/i.test(workflowId) ? workflowId : null,
        String(req.body.route_path || '').slice(0, 2000) || null,
        {
          receipt_no: String(req.body.receipt_no || '').slice(0, 160) || null,
          direction: String(req.body.direction || '').slice(0, 20) || null,
          amount: Number.isFinite(Number(req.body.amount)) ? Math.abs(Number(req.body.amount)) : null,
          form_snapshot: Array.isArray(req.body.form_snapshot) ? req.body.form_snapshot.slice(0, 80) : [],
        },
      ]
    );

    await writeAuditLog({
      organizationId: req.user.organization_id,
      siteId,
      userId: req.user.id,
      action: 'PRINT',
      eventType: 'RECEIPT',
      module,
      transactionName: req.body.receipt_no || `${module} receipt`,
      amount: req.body.amount,
      entityType: 'transaction_receipt',
      entityId: recordId,
      requestMethod: 'POST',
      requestPath: req.originalUrl,
      statusCode: 201,
      outcome: 'SUCCESS',
      description: `${req.user.name || req.user.email || `User ${req.user.id}`} printed ${watermark.toLowerCase()} receipt copy #${printNumber}`,
      metadata: {
        print_number: printNumber,
        watermark,
        preview_print: req.body.preview_print === true,
        receipt_id: receipt.id,
        workflow_id: workflowId || null,
      },
      ipAddress: req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress,
      userAgent: req.get('user-agent'),
      requestId: crypto.randomUUID(),
    }, client);

    await client.query('COMMIT');
    const history = await historyForReceipt(receipt.id);
    res.status(201).json({ receipt, print: printResult.rows[0], print_number: printNumber, watermark, history });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const getReceiptHistory = asyncHandler(async (req, res) => {
  const module = cleanModule(req.params.module);
  const recordId = cleanRecordId(req.params.recordId);
  if (!module || !recordId) return res.status(400).json({ message: 'module and recordId are required' });

  const { rows } = await pool.query(
    `SELECT * FROM transaction_receipts
      WHERE organization_id = $1 AND module = $2 AND record_id = $3
      LIMIT 1`,
    [Number(req.user.organization_id) || 1, module, recordId]
  );
  const receipt = rows[0] || null;
  if (!receipt) return res.json({ receipt: null, history: [], print_count: 0 });
  await assertSiteAccess(req, receipt.site_id);
  const history = await historyForReceipt(receipt.id);
  res.json({ receipt, history, print_count: history.length });
});
