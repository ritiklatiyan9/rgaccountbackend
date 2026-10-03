import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { assertCommissionSite } from './plotCommissionV2.controller.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { driveClientFor, getDriveConnection, folderPathKey, sendDriveError, MODULE_ROOT_NAME } from '../services/googleDrive.service.js';
import { MODULE_KEY, buildPlotCommissionShareBundle, renderStatementHtml, renderDocumentsHtml, planShareFiles } from '../services/plotCommissionShare.service.js';
import { enqueueShare, getShareRow } from '../services/driveShareJobs.service.js';
import { existingShareFolderSegments } from '../services/driveShareDestination.service.js';

const SCOPES = new Set(['overall', 'transaction', 'documents']);
const FORMATS = ['doc', 'pdf', 'xlsx'];
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
  const rawFormats = src.formats === undefined ? ['xlsx'] : (Array.isArray(src.formats) ? src.formats : String(src.formats).split(','));
  const formats = FORMATS.filter((f) => rawFormats.map((v) => String(v).trim().toLowerCase()).includes(f));
  if (!formats.length && scope !== 'documents') throw bad('Pick at least one format (pdf, xlsx or doc)');
  const includeDocuments = scope === 'documents' || parseBool(src.include_documents, false);

  await assertCommissionSite(req.user, siteId);
  const entryVisibility = await resolveEntryVisibility(req.user, 'commissions');
  if (!entryVisibility.canViewAll && scope !== 'transaction') {
    throw Object.assign(new Error('Only users who can view all commission entries can share the full statement'), { statusCode: 403, code: 'SHARE_FULL_FORBIDDEN' });
  }
  return { plotId, siteId, scope, paymentId, formats, includeDocuments, entryVisibility };
};

const shareRowSql = `SELECT s.id, s.module, s.scope, s.label, s.folder_path, s.folder_url, s.files, s.status, s.error, s.progress,
                            s.site_id, st.name AS site_name, u.name AS shared_by_name, s.created_at, s.finished_at, s.entity_id, s.payment_id
                       FROM google_drive_shares s
                       LEFT JOIN users u ON u.id = s.shared_by
                       LEFT JOIN sites st ON st.id = s.site_id`;
const plotShareRows = (orgId, plotId, limit, siteId, visibility, userId) => pool.query(
  `${shareRowSql} WHERE s.organization_id = $1 AND s.module = $2 AND s.entity_type = 'plot' AND s.entity_id = $3
    AND s.site_id=$5 AND ($6::boolean OR (s.scope='transaction' AND s.shared_by=$7))
    ORDER BY s.created_at DESC, s.id DESC LIMIT $4`,
  [orgId, MODULE_KEY, plotId, limit, siteId, visibility.canViewAll, userId],
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
      getDriveConnection(orgId), plotShareRows(orgId, plotId, 1, siteId, entryVisibility, req.user.id), siteRecipients(orgId, siteId),
    ]);
  } catch (err) {
    return sendDriveError(res, err);
  }
  bundle.folderSegments = await existingShareFolderSegments({ orgId, siteId, plotId, rootFolderId: connection?.root_folder_id }, bundle.folderSegments);
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

const shareRowOut = (row) => ({ ...row, request: undefined });

/**
 * POST /drive-shares/plot-commission — validates, checks the Drive connection,
 * queues the share and answers 202 at once. The background runner uploads and
 * pushes `drive_share:progress` / `drive_share:done` to the user's sockets;
 * GET /drive-shares/:id is the polling fallback.
 */
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

  // Validate the plan now so an empty selection answers 400 instead of a failed job.
  const bundle = await buildPlotCommissionShareBundle({ plotId, siteId, user: req.user, entryVisibility, scope, paymentId, includeDocuments });
  const plan = planShareFiles(bundle, { scope, formats, includeDocuments });
  if (!plan.some((f) => !f.skipped_reason)) throw bad('Nothing to share: no files match the selected scope and options');

  try {
    bundle.folderSegments = await existingShareFolderSegments({ orgId, siteId, plotId, rootFolderId: ctx.connection.root_folder_id }, bundle.folderSegments);
    const { rows } = await pool.query(
      `SELECT 1 FROM google_drive_shares WHERE organization_id=$1 AND module=$2 AND entity_type='plot' AND entity_id=$3 AND status IN ('queued','running') LIMIT 1`,
      [orgId, MODULE_KEY, plotId],
    );
    if (rows[0]) return res.status(409).json({ message: 'A share for this plot is already in progress', code: 'GOOGLE_DRIVE_SHARE_IN_PROGRESS' });
    const share = await enqueueShare({
      orgId, siteId, plotId, paymentId, scope, label: bundle.label,
      folderPath: folderPathKey([ctx.connection.root_folder_name || MODULE_ROOT_NAME, bundle.siteFolderName, ...bundle.folderSegments]),
      request: { formats, include_documents: includeDocuments },
      userId: req.user.id,
      prepared: { bundle, entryVisibility },
    });
    res.status(202).json({ share: shareRowOut(share) });
  } catch (err) {
    sendDriveError(res, err);
  }
});

/** GET /drive-shares/:id — one share with its live progress (polling fallback for the socket). */
export const getShare = asyncHandler(async (req, res) => {
  const id = positiveInt(req.params.id);
  if (!id) throw bad('Invalid share id');
  try {
    const row = await getShareRow(id);
    if (!row || Number(row.organization_id) !== Number(req.user.organization_id)) return res.status(404).json({ message: 'Share not found' });
    if (row.site_id) await assertCommissionSite(req.user, Number(row.site_id));
    const visibility = await resolveEntryVisibility(req.user, 'commissions');
    if (!visibility.canViewAll && (row.scope !== 'transaction' || Number(row.shared_by) !== Number(req.user.id))) {
      return res.status(404).json({ message: 'Share not found' });
    }
    const { rows: [names] } = await pool.query(
      'SELECT (SELECT name FROM users WHERE id=$1) AS shared_by_name, (SELECT name FROM sites WHERE id=$2) AS site_name',
      [row.shared_by, row.site_id],
    );
    res.json({ share: { ...shareRowOut(row), ...names } });
  } catch (err) {
    if (err?.statusCode) throw err;
    sendDriveError(res, err);
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
    const visibility = await resolveEntryVisibility(req.user, 'commissions');
    const { rows } = await plotShareRows(req.user.organization_id, plotId, 50, siteId, visibility, req.user.id);
    res.json({ shares: rows });
  } catch (err) {
    sendDriveError(res, err);
  }
});
