import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { driveClientFor, getDriveConnection, folderPathKey, sendDriveError, MODULE_ROOT_NAME, istDateFolder, siteFolderName } from '../services/googleDrive.service.js';
import { safeFilePart } from '../services/yearEndDocuments.service.js';
import { getModuleDriveDefinition, listModuleDriveDefinitions, assertModuleDriveAccess, buildModuleDriveShareBundle, planModuleDriveShareFiles } from '../services/moduleDriveShare.service.js';
import { renderModuleShareHtml } from '../services/driveShareWorkbook.service.js';
import { enqueueShare } from '../services/driveShareJobs.service.js';
import { existingModuleShareFolderSegments } from '../services/driveShareDestination.service.js';
import { normalizeModuleDriveFilters } from '../services/tdsDriveReport.service.js';

const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const publicShare = (row) => ({ ...row, request: undefined, organization_id: undefined });
const resolveRequest = async (req, mutation = false) => {
  const src = mutation ? req.body || {} : req.query;
  const moduleKey = String(req.params.moduleKey || '');
  const definition = getModuleDriveDefinition(moduleKey);
  if (!definition) throw bad('Unknown Drive sharing module');
  const siteId = positiveInt(src.site_id);
  if (!siteId) throw bad('site_id is required');
  const requestedEntity = src.entity_id !== undefined && src.entity_id !== null && src.entity_id !== '';
  const entityId = requestedEntity ? positiveInt(src.entity_id) : null;
  if (requestedEntity && (!entityId || !definition.entityScoped)) throw bad('Invalid record for this module');
  if (src.scope && src.scope !== 'overall') throw bad('Module sharing supports the overall scope');
  const formats = src.formats === undefined ? ['xlsx'] : (Array.isArray(src.formats) ? src.formats : String(src.formats).split(','));
  if (formats.length !== 1 || String(formats[0]).trim().toLowerCase() !== 'xlsx') throw bad('Module sharing uses Excel format');
  // Document links are included in Excel. Copying large attachments is a separate explicit operation.
  if (src.include_documents === true || String(src.include_documents).toLowerCase() === 'true') throw bad('Documents are shared as links inside Excel');
  const entryVisibility = await assertModuleDriveAccess({ moduleKey, siteId, user: req.user });
  const filters = normalizeModuleDriveFilters(moduleKey, src.filters);
  return { moduleKey, definition, siteId, entityId, entryVisibility, filters, formats: ['xlsx'], scope: 'overall' };
};

const historyRows = ({ orgId, moduleKey, siteId, entityType, entityId, visibility, userId, limit = 50 }) => pool.query(
  `SELECT s.id,s.module,s.scope,s.label,s.folder_path,s.folder_url,s.files,s.status,s.error,s.progress,
          s.site_id,st.name AS site_name,u.name AS shared_by_name,s.created_at,s.finished_at,s.entity_type,s.entity_id
     FROM google_drive_shares s LEFT JOIN users u ON u.id=s.shared_by LEFT JOIN sites st ON st.id=s.site_id
    WHERE s.organization_id=$1 AND s.module=$2 AND s.site_id=$3 AND s.entity_type=$4 AND s.entity_id=$5
      AND ($6::boolean OR (s.shared_by=$7 AND s.request->'visibility'->>'canViewAll'='false'
           AND s.request->'visibility'->>'creatorId'=$7::text))
    ORDER BY s.created_at DESC,s.id DESC LIMIT $8`,
  [orgId, moduleKey, siteId, entityType, entityId, visibility.canViewAll, userId, limit],
);
const identity = ({ definition, entityId, siteId }) => ({ entityType: entityId ? definition.entityType || 'record' : 'module', entityId: entityId || siteId });
const destination = (ctx, args, bundle) => existingModuleShareFolderSegments({
  orgId: args.orgId, siteId: args.siteId, moduleKey: args.moduleKey, entityType: bundle.entityType,
  entityId: bundle.entityId, moduleLabel: bundle.moduleLabel, rootFolderId: ctx?.root_folder_id,
}, bundle.folderSegments);

export const listDriveShareModules = asyncHandler(async (req, res) => {
  const siteId = positiveInt(req.query.site_id);
  if (!siteId) return res.json({ modules: [] });
  const modules = await Promise.all(listModuleDriveDefinitions().map(async (definition) => {
    try {
      const visibility = await assertModuleDriveAccess({ moduleKey: definition.key, siteId, user: req.user });
      return { ...definition, entry_scope: visibility.canViewAll ? 'all' : 'own' };
    } catch (error) {
      if ([403, 404].includes(error.statusCode)) return null;
      throw error;
    }
  }));
  res.json({ modules: modules.filter(Boolean) });
});

export const previewModuleShare = asyncHandler(async (req, res) => {
  const args = await resolveRequest(req);
  const orgId = req.user.organization_id;
  const bundle = await buildModuleDriveShareBundle({ ...args, user: req.user });
  const plan = planModuleDriveShareFiles(bundle, { formats: args.formats });
  try {
    const [connection, { rows: recipients }, { rows: [lastShare] }] = await Promise.all([
      getDriveConnection(orgId),
      pool.query('SELECT email,role,site_id FROM google_drive_access_emails WHERE organization_id=$1 AND (site_id=$2 OR site_id IS NULL) ORDER BY email', [orgId, args.siteId]),
      historyRows({ orgId, ...args, ...identity(args), visibility: args.entryVisibility, userId: req.user.id, limit: 1 }),
    ]);
    bundle.folderSegments = await destination(connection, { ...args, orgId }, bundle);
    res.json({ connected: connection?.status === 'active', connection_status: connection?.status || 'disconnected',
      can_share_full: true, formats: ['xlsx'], supports_documents: false, document_links: true,
      entry_scope: args.entryVisibility.canViewAll ? 'all' : 'own',
      folder_path: [connection?.root_folder_name || MODULE_ROOT_NAME, bundle.siteFolderName || bundle.site.name, ...bundle.folderSegments],
      recipients: recipients.map((r) => ({ email: r.email, role: r.role, all_sites: r.site_id == null })),
      label: bundle.label, groups: plan.map(({ folder, name, kind, formats }) => ({ folder, files: [{ name, kind, formats }] })),
      preview_html: renderModuleShareHtml(bundle), summary: { ...bundle.summary, site_name: bundle.site.name },
      view_filters: bundle.viewFilters,
      last_share: lastShare ? publicShare(lastShare) : null,
    });
  } catch (err) { if (err.statusCode) throw err; return sendDriveError(res, err); }
});

export const createModuleShare = asyncHandler(async (req, res) => {
  const args = await resolveRequest(req, true);
  const orgId = req.user.organization_id;
  try {
    const ctx = await driveClientFor(orgId);
    if (!ctx) {
      const connection = await getDriveConnection(orgId);
      return res.status(409).json({ message: connection?.status === 'reauthorization_required' ? 'Google Drive access expired. Reconnect Google Drive in Settings.' : 'Connect Google Drive in Settings first',
        code: connection?.status === 'reauthorization_required' ? 'GOOGLE_DRIVE_REAUTH' : 'GOOGLE_DRIVE_NOT_CONNECTED' });
    }
    // Queue after authorization and record validation. The worker reads the
    // full dataset while publishing progress, avoiding a second large export
    // query in this HTTP request after the user has already seen the preview.
    const { rows: [site] } = await pool.query('SELECT id,name FROM sites WHERE id=$1 AND organization_id=$2', [args.siteId, orgId]);
    if (!site) throw Object.assign(new Error('Site not found'), { statusCode: 404 });
    let label = `${site.name} — ${args.definition.label}`;
    if (args.entityId) {
      const { rows: [record] } = await pool.query('SELECT id,plot_no FROM plots WHERE id=$1 AND site_id=$2', [args.entityId, args.siteId]);
      if (!record) throw Object.assign(new Error('Plot not found in this site'), { statusCode: 404 });
      label = `Plot ${record.plot_no}`;
    }
    const bundle = { ...identity(args), moduleLabel: args.definition.label, label, site, siteFolderName: siteFolderName(site),
      folderSegments: [istDateFolder(new Date()), args.definition.label, safeFilePart(label)] };
    bundle.folderSegments = await destination(ctx.connection, { ...args, orgId }, bundle);
    const { rows } = await pool.query(`SELECT 1 FROM google_drive_shares WHERE organization_id=$1 AND site_id=$2
      AND module=$3 AND entity_type=$4 AND entity_id=$5 AND status IN ('queued','running') LIMIT 1`,
    [orgId, args.siteId, args.moduleKey, bundle.entityType, bundle.entityId]);
    if (rows.length) return res.status(409).json({ message: 'A share for this module or record is already in progress', code: 'GOOGLE_DRIVE_SHARE_IN_PROGRESS' });
    const share = await enqueueShare({ orgId, siteId: args.siteId, moduleKey: args.moduleKey, entityType: bundle.entityType, entityId: bundle.entityId,
      scope: 'overall', label: bundle.label, folderPath: folderPathKey([ctx.connection.root_folder_name || MODULE_ROOT_NAME, bundle.siteFolderName || bundle.site.name, ...bundle.folderSegments]),
      request: { formats: ['xlsx'], include_documents: false, visibility: args.entryVisibility, record_id: args.entityId, filters: args.filters },
      userId: req.user.id,
    });
    res.status(202).json({ share: publicShare(share) });
  } catch (err) { if (err.statusCode) throw err; return sendDriveError(res, err); }
});

export const listModuleShares = asyncHandler(async (req, res) => {
  const args = await resolveRequest(req);
  try {
    const { rows } = await historyRows({ orgId: req.user.organization_id, ...args, ...identity(args), visibility: args.entryVisibility, userId: req.user.id });
    res.json({ shares: rows });
  } catch (err) { return sendDriveError(res, err); }
});

export const assertModuleShareVisible = async (user, row) => {
  const visibility = await assertModuleDriveAccess({ moduleKey: row.module, siteId: Number(row.site_id), user });
  if (!visibility.canViewAll && (Number(row.shared_by) !== Number(user.id) || row.request?.visibility?.canViewAll !== false
    || String(row.request?.visibility?.creatorId) !== String(visibility.creatorId))) {
    throw Object.assign(new Error('Share not found'), { statusCode: 404 });
  }
  return visibility;
};
