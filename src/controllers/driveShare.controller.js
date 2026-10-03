import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { assertCommissionSite } from './plotCommissionV2.controller.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import {
  driveClientFor, getDriveConnection, ensureSiteFolder, ensureFolderPath, upsertFile, exportPdf,
  folderPathKey, folderUrl, sendDriveError, tryPlotShareLock, translateDriveError, MODULE_ROOT_NAME,
} from '../services/googleDrive.service.js';
import {
  MODULE_KEY, buildPlotCommissionShareBundle, renderStatementHtml, renderProfileHtml, renderDocumentsHtml,
  buildStatementXlsx, planShareFiles, readStoredFileBytes,
} from '../services/plotCommissionShare.service.js';

const SCOPES = new Set(['overall', 'transaction', 'documents']);
const FORMATS = ['doc', 'pdf', 'xlsx'];
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// Drive uploads are sequential and in-request; keep one share bounded.
const MAX_SHARE_BYTES = 150 * 1024 * 1024;

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const parseBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no'].includes(String(value).toLowerCase());
};

/** Validates plot/site/scope/options and resolves what this user may see. Shared by preview + create. */
const resolveRequest = async (req, { mutation = false } = {}) => {
  const src = mutation ? req.body || {} : req.query;
  const plotId = positiveInt(src.plot_id);
  const siteId = positiveInt(src.site_id);
  if (!plotId) throw bad('plot_id is required');
  if (!siteId) throw bad('site_id is required');
  const scope = src.scope ? String(src.scope) : 'overall';
  if (!SCOPES.has(scope)) throw bad('scope must be overall, transaction or documents');
  const paymentId = scope === 'transaction' ? positiveInt(src.payment_id) : null;
  if (scope === 'transaction' && !paymentId) throw bad('payment_id is required for a transaction share');
  const rawFormats = src.formats === undefined ? FORMATS : (Array.isArray(src.formats) ? src.formats : String(src.formats).split(','));
  const formats = FORMATS.filter((f) => rawFormats.map((v) => String(v).trim().toLowerCase()).includes(f));
  if (!formats.length && scope !== 'documents') throw bad('Pick at least one format (pdf, xlsx or doc)');
  const includeDocuments = parseBool(src.include_documents, true);

  await assertCommissionSite(req.user, siteId);
  const entryVisibility = await resolveEntryVisibility(req.user, 'commissions');
  if (!entryVisibility.canViewAll && scope !== 'transaction') {
    throw Object.assign(new Error('Only users who can view all commission entries can share the full statement'), { statusCode: 403, code: 'SHARE_FULL_FORBIDDEN' });
  }
  return { plotId, siteId, scope, paymentId, formats, includeDocuments, entryVisibility };
};

const shareRowSql = `SELECT s.id, s.module, s.scope, s.label, s.folder_path, s.folder_url, s.files, s.status, s.error,
                            s.site_id, st.name AS site_name, u.name AS shared_by_name, s.created_at, s.entity_id, s.payment_id
                       FROM google_drive_shares s
                       LEFT JOIN users u ON u.id = s.shared_by
                       LEFT JOIN sites st ON st.id = s.site_id`;
const plotShareRows = (orgId, plotId, limit) => pool.query(
  `${shareRowSql} WHERE s.organization_id = $1 AND s.module = $2 AND s.entity_type = 'plot' AND s.entity_id = $3
    ORDER BY s.created_at DESC, s.id DESC LIMIT $4`,
  [orgId, MODULE_KEY, plotId, limit],
);

// Who can open this site's folder — shown before sharing so nobody uploads into a folder no CA reads.
const siteRecipients = (orgId, siteId) => pool.query(
  `SELECT email, role, site_id FROM google_drive_access_emails
    WHERE organization_id=$1 AND (site_id=$2 OR site_id IS NULL) ORDER BY email`,
  [orgId, siteId],
);

const previewHtml = (bundle, plan) => {
  if (bundle.scope === 'documents') return renderDocumentsHtml(bundle, plan);
  return renderStatementHtml(bundle);
};
// Storage keys / bucket URLs stay server-side; the dialog only needs names and sizes.
const groupPlan = (plan) => {
  const groups = new Map();
  for (const { folder, name, kind, formats, mime_type = null, size = null, skipped_reason = null } of plan) {
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push({ name, kind, formats, mime_type, size, skipped_reason });
  }
  return [...groups].map(([folder, files]) => ({ folder, files }));
};

/** GET /drive-shares/plot-commission/preview */
export const previewPlotCommissionShare = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const { plotId, siteId, scope, paymentId, formats, includeDocuments, entryVisibility } = await resolveRequest(req);
  const bundle = await buildPlotCommissionShareBundle({ plotId, siteId, user: req.user, entryVisibility, scope, paymentId });
  const plan = planShareFiles(bundle, { scope, formats, includeDocuments });

  let connection;
  let lastShare;
  let recipients;
  try {
    [connection, { rows: [lastShare] }, { rows: recipients }] = await Promise.all([
      getDriveConnection(orgId), plotShareRows(orgId, plotId, 1), siteRecipients(orgId, siteId),
    ]);
  } catch (err) {
    return sendDriveError(res, err);
  }
  res.json({
    connected: connection?.status === 'active',
    connection_status: connection?.status || 'disconnected',
    can_share_full: entryVisibility.canViewAll,
    // Full location as the CA sees it in Drive: root / site / date / module / record.
    folder_path: [connection?.root_folder_name || MODULE_ROOT_NAME, bundle.siteFolderName, ...bundle.folderSegments],
    recipients: recipients.map((r) => ({ email: r.email, role: r.role, all_sites: r.site_id == null })),
    label: bundle.label,
    groups: groupPlan(plan),
    preview_html: previewHtml(bundle, plan),
    summary: {
      plot_no: bundle.plot.plot_no,
      site_name: bundle.site.name,
      agents: bundle.agents.map((a) => a.agent_name),
      total_commission: bundle.totals.total_commission,
      total_paid: bundle.totals.total_paid,
      tds_total: bundle.totals.tds_total,
      balance: bundle.totals.balance,
      payment_count: bundle.payment ? 1 : bundle.totals.payment_count,
      // What exists for this scope, independent of the include-documents switch.
      documents_count: bundle.documents.length + bundle.vouchers.length + bundle.signatures.length,
    },
    last_share: lastShare
      ? { id: lastShare.id, created_at: lastShare.created_at, shared_by_name: lastShare.shared_by_name, folder_url: lastShare.folder_url, scope: lastShare.scope, status: lastShare.status }
      : null,
  });
});

const shortReason = (err) => (err?.code === 'UNSUPPORTED_STORAGE' ? 'Stored outside the app bucket'
  : err?.code === 'FILE_TOO_LARGE' ? err.message
    : translateDriveError(err).message);

/** Uploads one planned file (and its derived formats) into Drive, recording success or a short failure reason. */
const uploadPlanned = async ({ ctx, bundle, item, parentId, files, budget }) => {
  const record = (extra) => files.push({ folder: item.folder, name: item.name, kind: item.kind, mime_type: null, drive_file_id: null, url: null, error: null, ...extra });
  const spend = (bytes) => {
    if (budget.used + bytes > MAX_SHARE_BYTES) throw Object.assign(new Error('Share size limit reached'), { code: 'FILE_TOO_LARGE' });
    budget.used += bytes;
  };
  // Returns the files[] entry plus whether Drive created the file on this request.
  const put = async (name, mimeType, body, convertTo) => {
    spend(Buffer.byteLength(body));
    const file = await upsertFile(ctx, { parentId, name, mimeType, body, convertTo });
    return { record: { name, mime_type: file.mime_type || convertTo || mimeType, drive_file_id: file.id, url: file.url }, created: file.created };
  };

  if (item.kind === 'document' || item.kind === 'voucher' || item.kind === 'signature') {
    try {
      const { bytes, mime_type } = await readStoredFileBytes(item.source);
      record((await put(item.name, item.mime_type || mime_type, bytes)).record);
    } catch (err) {
      record({ error: shortReason(err) });
    }
    return;
  }

  const html = item.kind === 'profile' ? renderProfileHtml(bundle) : renderStatementHtml(bundle);
  const wantDoc = item.formats.includes('doc');
  const wantPdf = item.formats.includes('pdf');
  let doc = null;
  if (wantDoc || wantPdf) {
    try {
      doc = await put(item.name, 'text/html', html, GOOGLE_DOC);
      if (wantDoc) record(doc.record);
    } catch (err) {
      record({ error: shortReason(err) });
      if (wantPdf) record({ name: `${item.name}.pdf`, error: shortReason(err) });
    }
  }
  if (doc && wantPdf) {
    try {
      record((await put(`${item.name}.pdf`, 'application/pdf', await exportPdf(ctx, doc.record.drive_file_id))).record);
    } catch (err) {
      record({ name: `${item.name}.pdf`, error: shortReason(err) });
    }
    // A Doc created only as this PDF's conversion source is dropped again; one
    // an earlier share created (and this request merely refreshed) stays put.
    if (!wantDoc && doc.created) await ctx.drive.files.delete({ fileId: doc.record.drive_file_id }).catch(() => {});
  }
  if (item.kind === 'statement' && item.formats.includes('xlsx')) {
    try {
      record((await put(`${item.name}.xlsx`, XLSX_MIME, buildStatementXlsx(bundle))).record);
    } catch (err) {
      record({ name: `${item.name}.xlsx`, error: shortReason(err) });
    }
  }
};

const summarizeFailures = (files) => {
  const failed = files.filter((f) => f.error);
  if (!failed.length) return null;
  const names = failed.slice(0, 5).map((f) => f.name).join(', ');
  return `${failed.length} of ${files.length} files skipped: ${names}${failed.length > 5 ? ', …' : ''}`;
};

/** POST /drive-shares/plot-commission */
export const createPlotCommissionShare = asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const { plotId, siteId, scope, paymentId, formats, includeDocuments, entryVisibility } = await resolveRequest(req, { mutation: true });

  let ctx;
  try {
    ctx = await driveClientFor(orgId);
    if (!ctx) {
      const latest = await getDriveConnection(orgId);
      return latest?.status === 'reauthorization_required'
        ? res.status(409).json({ message: 'Google Drive access expired. Reconnect Google Drive in Settings.', code: 'GOOGLE_DRIVE_REAUTH' })
        : res.status(409).json({ message: 'Connect Google Drive in Settings first', code: 'GOOGLE_DRIVE_NOT_CONNECTED' });
    }
  } catch (err) {
    return sendDriveError(res, err);
  }

  const lock = await tryPlotShareLock(orgId, plotId);
  if (!lock) return res.status(409).json({ message: 'A share for this plot is already in progress', code: 'GOOGLE_DRIVE_SHARE_IN_PROGRESS' });
  try {
    const bundle = await buildPlotCommissionShareBundle({ plotId, siteId, user: req.user, entryVisibility, scope, paymentId });
    const plan = planShareFiles(bundle, { scope, formats, includeDocuments });
    if (!plan.some((f) => !f.skipped_reason)) throw bad('Nothing to share: no files match the selected scope and options');
    const folderPath = folderPathKey([ctx.connection.root_folder_name || MODULE_ROOT_NAME, bundle.siteFolderName, ...bundle.folderSegments]);
    const files = [];
    const insertShare = async (folderId, status, error) => {
      const { rows } = await pool.query(
        `INSERT INTO google_drive_shares
           (organization_id, site_id, module, entity_type, entity_id, payment_id, scope, label, folder_path, folder_id, folder_url, files, status, error, shared_by)
         VALUES ($1, $2, $3, 'plot', $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
         RETURNING id, folder_url, folder_path, label, scope, payment_id, files, status, error, created_at`,
        [orgId, siteId, MODULE_KEY, plotId, paymentId, scope, bundle.label, folderPath, folderId, folderId ? folderUrl(folderId) : null,
          JSON.stringify(files), status, error, req.user.id],
      );
      return rows[0];
    };

    let baseId;
    let siteFolder;
    try {
      // The site folder carries the CA's grant; everything below inherits it.
      siteFolder = await ensureSiteFolder(ctx, { id: siteId, name: bundle.site.name });
      baseId = await ensureFolderPath(ctx, bundle.folderSegments, { base: siteFolder });
    } catch (err) {
      await insertShare(null, 'failed', translateDriveError(err).message).catch((dbErr) => console.error('[gdrive] share row insert failed', dbErr));
      return sendDriveError(res, err);
    }

    const subfolders = new Map();
    const budget = { used: 0 };
    for (const item of plan) {
      if (item.skipped_reason) {
        files.push({ folder: item.folder, name: item.name, kind: item.kind, mime_type: item.mime_type || null, drive_file_id: null, url: null, error: item.skipped_reason });
        continue;
      }
      let parentId;
      try {
        if (!subfolders.has(item.folder)) subfolders.set(item.folder, await ensureFolderPath(ctx, [...bundle.folderSegments, item.folder], { base: siteFolder }));
        parentId = subfolders.get(item.folder);
      } catch (err) {
        files.push({ folder: item.folder, name: item.name, kind: item.kind, mime_type: null, drive_file_id: null, url: null, error: shortReason(err) });
        continue;
      }
      await uploadPlanned({ ctx, bundle, item, parentId, files, budget });
    }

    const uploaded = files.filter((f) => !f.error).length;
    const status = uploaded === 0 ? 'failed' : uploaded === files.length ? 'completed' : 'partial';
    let share;
    try {
      share = await insertShare(baseId, status, summarizeFailures(files));
    } catch (err) {
      return sendDriveError(res, err);
    }
    res.status(201).json({ share });
  } finally {
    await lock.release();
  }
});

/** GET /drive-shares/plot-commission/:plotId?site_id= */
export const listPlotCommissionShares = asyncHandler(async (req, res) => {
  const plotId = positiveInt(req.params.plotId);
  const siteId = positiveInt(req.query.site_id);
  if (!plotId) throw bad('Invalid plot id');
  if (!siteId) throw bad('site_id is required');
  await assertCommissionSite(req.user, siteId);
  try {
    const { rows } = await plotShareRows(req.user.organization_id, plotId, 50);
    res.json({ shares: rows });
  } catch (err) {
    sendDriveError(res, err);
  }
});
