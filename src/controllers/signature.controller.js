import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { loadReceiptImage } from '../utils/receiptImages.js';

// One endpoint signs any receipt row. Strict allowlist: target → table +
// permission module. Only the two signature columns are writable here, so
// module-specific validation rules (e.g. vendor's required amount/date)
// stay untouched.
export const SIGN_TARGETS = {
  partner_profit_payment: { table: 'partner_profit_payments', perm: 'sites', adminOnly: true, siteQuery: 'SELECT site_id FROM partner_profit_payments WHERE id = $1 LIMIT 1' },
  expense: {
    table: 'expenses',
    perm: 'expenses',
    siteQuery: 'SELECT site_id FROM expenses WHERE id = $1 LIMIT 1',
  },
  farmer_payment: {
    table: 'farmer_payments',
    perm: 'farmers',
    siteQuery: `SELECT f.site_id
                  FROM farmer_payments fp
                  JOIN farmers f ON f.id = fp.farmer_id
                 WHERE fp.id = $1
                 LIMIT 1`,
  },
  daybook: {
    table: 'day_book',
    perm: 'daybook',
    siteQuery: 'SELECT site_id FROM day_book WHERE id = $1 LIMIT 1',
  },
  vendor_payment: {
    table: 'vendor_payments',
    perm: 'vendors',
    siteQuery: 'SELECT site_id FROM vendor_payments WHERE id = $1 LIMIT 1',
  },
  plot_payment: {
    table: 'plot_payments',
    perm: 'plot_payments',
    siteQuery: 'SELECT site_id FROM plot_payments WHERE id = $1 LIMIT 1',
  },
  registry_payment: {
    table: 'plot_registry_payments',
    perm: 'plot_registry',
    siteQuery: 'SELECT site_id FROM plot_registry_payments WHERE id = $1 LIMIT 1',
  },
  commission_payment: {
    table: 'plot_commission_payments',
    perm: 'commissions',
    siteQuery: 'SELECT site_id FROM plot_commission_payments WHERE id = $1 LIMIT 1',
  },
  cashflow_entry: {
    table: 'cash_flow_entries',
    perm: 'cashflow',
    siteQuery: 'SELECT site_id FROM cash_flow_entries WHERE id = $1 LIMIT 1',
  },
  firm_transaction: {
    table: 'firm_transactions',
    perm: 'firm_transactions',
    siteQuery: 'SELECT site_id FROM firm_transactions WHERE id = $1 LIMIT 1',
  },
  land_deal_payment: {
    table: 'land_deal_payments',
    perm: 'farmers',
    siteQuery: 'SELECT site_id FROM land_deal_payments WHERE id = $1 LIMIT 1',
  },
  vendor_inventory_payment: {
    table: 'vendor_inventory_payments',
    perm: 'vendors',
    siteQuery: 'SELECT site_id FROM vendor_inventory_payments WHERE id = $1 LIMIT 1',
  },
};

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

export const getSignatureImages = asyncHandler(async (req, res) => {
  const target = SIGN_TARGETS[req.params.target];
  const id = Number(req.params.id);
  if (!target || !Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid signature record' });
  if (!await requireTargetSiteAccess(req, res, target, id)) return;
  const includeEvidence = req.query?.include_evidence === 'true';
  const { rows } = await pool.query(
    `SELECT to_jsonb(t)->>'customer_signature_url' AS customer_signature_url,
            to_jsonb(t)->>'authority_signature_url' AS authority_signature_url
            ${includeEvidence ? `, COALESCE(NULLIF(to_jsonb(t)->>'evidence_photo_url', ''),
              NULLIF(to_jsonb(t)->>'photo_url', ''), NULLIF(to_jsonb(t)->>'voucher_url', ''),
              NULLIF(to_jsonb(t)->>'proof_url', '')) AS evidence_photo_url` : ''}
       FROM ${target.table} t WHERE id = $1`, [id]
  );
  const history = await pool.query(
    `SELECT customer_signature_url, authority_signature_url${includeEvidence ? ', evidence_photo_url' : ''} FROM transaction_receipts
      WHERE organization_id = $1 AND module = $2 AND record_id = $3 LIMIT 1`,
    [Number(req.user.organization_id) || 1, req.params.target, String(id)]
  );
  const urls = [...new Set([...Object.values(rows[0] || {}), ...Object.values(history.rows[0] || {})].filter(Boolean))];
  try {
    // An inaccessible old attachment must not discard readable current signatures.
    const results = await Promise.allSettled(urls.map(async (url) => [url, await loadReceiptImage(url)]));
    const images = Object.fromEntries(results.filter(result => result.status === 'fulfilled').map(result => result.value));
    if (results.length && !Object.keys(images).length) throw results.find(result => result.status === 'rejected').reason;
    res.set('Cache-Control', 'no-store');
    res.json({ images });
  } catch (error) {
    const failedBucket = urls.map((url) => {
      try { return new URL(url).hostname.match(/^(.+)\.s3[.-]/)?.[1]; } catch { return null; }
    }).find(Boolean);
    console.error('Receipt signature retrieval failed:', {
      name: error.name,
      code: error.Code || error.code,
      bucket: failedBucket,
    });
    const denied = error.name === 'AccessDenied' || error.Code === 'AccessDenied' || error.code === 'AccessDenied';
    res.status(502).json({
      message: denied
        ? `The backend AWS identity cannot read saved signatures from ${failedBucket || 'the configured S3 bucket'}. Grant s3:GetObject for its vouchers/* objects, then retry.`
        : 'The saved signature could not be read from storage. Check the backend S3 read permission and bucket configuration, then retry.',
      code: denied ? 'SIGNATURE_STORAGE_ACCESS_DENIED' : 'SIGNATURE_STORAGE_READ_FAILED',
      ...(failedBucket ? { bucket: failedBucket } : {}),
    });
  }
});

// Resolves the record, enforces the site boundary and hands the row back, so a
// caller that needs the owning site (party links) does not re-query for it.
// Falsy return means a response has already been sent.
export const requireTargetSiteAccess = async (req, res, target, id) => {
  const { rows } = await pool.query(target.siteQuery, [id]);
  if (!rows[0]) {
    res.status(404).json({ message: 'Record not found' });
    return false;
  }

  if (ADMIN_ROLES.has(req.user.role)) return rows[0];

  const siteId = Number(rows[0].site_id);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    res.status(403).json({ message: 'Record is not linked to an accessible site' });
    return false;
  }

  const access = await pool.query(
    'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
    [req.user.id, siteId]
  );
  if (!access.rows[0]) {
    res.status(403).json({ message: 'Access denied to this site' });
    return false;
  }

  return rows[0];
};

/**
 * PUT /signatures/:target/:id
 * Body: { customer_signature_url?, authority_signature_url? }
 */
export const saveSignatures = asyncHandler(async (req, res) => {
  const target = SIGN_TARGETS[req.params.target];
  if (!target) return res.status(400).json({ message: 'Unknown signature target' });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid id' });

  if (!await requireTargetSiteAccess(req, res, target, id)) return;

  const { customer_signature_url, authority_signature_url } = req.body;
  const sets = [];
  const params = [];
  if (customer_signature_url !== undefined) {
    params.push(customer_signature_url || null);
    sets.push(`customer_signature_url = $${params.length}`);
  }
  if (authority_signature_url !== undefined) {
    params.push(authority_signature_url || null);
    sets.push(`authority_signature_url = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);

  const result = await pool.query(
    `UPDATE ${target.table} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Record not found' });
  res.json({ message: 'Signatures saved', id: result.rows[0].id });
});
