import crypto from 'crypto';
import zlib from 'zlib';
import express from 'express';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import { writeAuditLog } from '../services/auditLog.service.js';
import { assertComplianceSiteAccess, parsePositiveId, isOrgAdmin } from '../utils/complianceAccess.js';
import {
  groupOpsBySheet, sanitizeSheetSnapshot, validateSheetList, resolveAccessLevel, hasLevel, SpreadsheetOpError,
} from '../utils/spreadsheetOps.js';
import * as model from '../models/spreadsheet.model.js';

const MAX_NAME = 255;
const SHARE_LEVELS = new Set(['editor', 'commenter', 'viewer']);
// Business events the client may report alongside a change batch. Cell edits
// are deliberately NOT audited one by one; the version history covers them.
const CLIENT_EVENTS = new Set(['SHEET_CREATED', 'SHEET_DELETED', 'SHEET_RENAMED', 'WORKBOOK_RENAMED']);

/**
 * Large payloads (imports, sheet snapshots) arrive gzip-compressed as
 * application/octet-stream so the global 25 MB JSON limit does not apply and
 * a 50k-row sheet ships in a few MB. Regular JSON bodies pass straight through.
 */
export const compressedJsonBody = [
  express.raw({ type: 'application/octet-stream', limit: '200mb' }),
  (req, res, next) => {
    if (!Buffer.isBuffer(req.body)) return next();
    try {
      req.body = JSON.parse(zlib.gunzipSync(req.body).toString('utf8'));
    } catch {
      return res.status(400).json({ message: 'The compressed payload could not be read' });
    }
    return next();
  },
];

const cleanName = (value, fallback = 'Untitled Workbook') => {
  // eslint-disable-next-line no-control-regex
  const name = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_NAME);
  return name || fallback;
};

const getExcelPermission = async (req) => {
  if (req.user.role !== 'sub_admin') return null;
  const cache = req.user.permissionsByModule;
  if (cache instanceof Map && cache.has('excel')) return cache.get('excel');
  const permission = await permissionModel.getPermission(req.user.id, 'excel');
  if (cache instanceof Map) cache.set('excel', permission);
  return permission;
};

const audit = (req, { action, workbook, description, metadata, amount }) => writeAuditLog({
  organizationId: req.user.organization_id,
  siteId: workbook?.site_id ?? null,
  userId: req.user.id,
  action,
  eventType: 'SPREADSHEET',
  module: 'excel',
  transactionName: workbook?.name ?? null,
  amount,
  entityType: 'workbook',
  entityId: workbook?.id ?? null,
  requestMethod: req.method,
  requestPath: req.originalUrl,
  outcome: 'SUCCESS',
  description,
  metadata: { ...(metadata || {}), session_id: req.sessionId || null },
  ipAddress: req.headers['x-forwarded-for'] || req.ip,
  userAgent: req.get('user-agent'),
}).catch((error) => console.error('[spreadsheet audit] write failed:', error.message));

const permissionsFor = (level) => ({
  can_edit: hasLevel(level, 'editor'),
  can_comment: hasLevel(level, 'commenter'),
  can_share: hasLevel(level, 'owner'),
  can_delete: hasLevel(level, 'owner'),
  can_view_history: hasLevel(level, 'editor'),
  can_restore_version: hasLevel(level, 'owner'),
});

/**
 * Tenant + site + share resolution for one workbook. Unknown, foreign-tenant
 * and invisible workbooks all answer 404 so an ID probe learns nothing.
 */
async function loadAccess(req, res, { includeDeleted = false, minimum = 'viewer' } = {}) {
  const id = parsePositiveId(req.params.id);
  if (!id) {
    res.status(404).json({ message: 'Workbook not found' });
    return null;
  }
  const workbook = await model.findWorkbookForUser(req.user, id, { includeDeleted });
  const permission = workbook ? await getExcelPermission(req) : null;
  const level = workbook
    ? resolveAccessLevel({ user: req.user, workbook, shareLevel: workbook.share_level, siteOk: workbook.site_ok, permission })
    : null;
  if (!level) {
    res.status(404).json({ message: 'Workbook not found' });
    return null;
  }
  if (!hasLevel(level, minimum)) {
    res.status(403).json({
      message: minimum === 'owner'
        ? 'Only the workbook owner can do this'
        : 'You no longer have permission to edit this workbook',
      code: 'WORKBOOK_ACCESS_LEVEL',
    });
    return null;
  }
  return { workbook, level };
}

const blankSheet = () => ({ id: crypto.randomUUID(), name: 'Sheet1', celldata: [], order: 0, hide: 0 });

const resolveSiteForCreate = async (req, res, rawSiteId) => {
  if (rawSiteId === null || rawSiteId === undefined || rawSiteId === '') {
    if (isOrgAdmin(req.user)) return null; // organisation-wide workbook
    res.status(400).json({ message: 'Select a site for this workbook' });
    return false;
  }
  return assertComplianceSiteAccess(req, res, rawSiteId, { required: true });
};

/** GET /spreadsheets */
export const listWorkbooks = asyncHandler(async (req, res) => {
  const siteId = req.query.site_id ? parsePositiveId(req.query.site_id) : null;
  if (req.query.site_id && !siteId) return res.status(400).json({ message: 'Invalid site' });
  if (siteId && !isOrgAdmin(req.user)) {
    const ok = await assertComplianceSiteAccess(req, res, siteId, { required: true });
    if (!ok) return undefined;
  }
  const permission = await getExcelPermission(req);
  const rows = await model.listWorkbooks(req.user, {
    siteId,
    search: String(req.query.q || '').trim().slice(0, 120),
    deleted: req.query.deleted === 'true',
    permission,
  });
  const workbooks = rows.map((row) => {
    const level = resolveAccessLevel({ user: req.user, workbook: row, shareLevel: row.share_level, siteOk: row.site_ok, permission });
    const { share_level: _share, site_ok: _ok, ...workbook } = row;
    return { ...workbook, access_level: level };
  }).filter((row) => row.access_level);
  return res.json({ workbooks });
});

/** POST /spreadsheets — blank workbook or an imported one (sheets in body). */
export const createWorkbook = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const siteId = await resolveSiteForCreate(req, res, body.site_id);
  if (siteId === false) return undefined;
  const name = cleanName(body.name);
  const imported = Array.isArray(body.sheets) && body.sheets.length > 0;
  const sheets = imported ? validateSheetList(body.sheets) : [blankSheet()];
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};

  const workbookId = await model.createWorkbook({
    user: req.user, siteId, name, description: body.description ? String(body.description).slice(0, 2000) : null,
    sheets, settings, versionAction: imported ? 'IMPORT' : null,
  });
  const workbook = await model.findWorkbookForUser(req.user, workbookId);
  await audit(req, {
    action: imported ? 'WORKBOOK_IMPORTED' : 'WORKBOOK_CREATED',
    workbook,
    description: `${imported ? 'Imported' : 'Created'} workbook "${name}"`,
    metadata: {
      sheet_count: sheets.length,
      cell_count: sheets.reduce((sum, sheet) => sum + sheet.celldata.length, 0),
      source_file: body.source_file ? String(body.source_file).slice(0, 255) : undefined,
      import_report: body.import_report,
    },
  });
  return res.status(201).json({ workbook: { ...workbook, access_level: 'owner' }, sheets, permissions: permissionsFor('owner') });
});

/** POST /spreadsheets/legacy/:fileId — turn an S3-backed excel_files row into a workbook. */
export const convertLegacyFile = asyncHandler(async (req, res) => {
  const fileId = parsePositiveId(req.params.fileId);
  if (!fileId) return res.status(404).json({ message: 'File not found' });
  const { rows } = await pool.query('SELECT id, name, site_id FROM excel_files WHERE id = $1 LIMIT 1', [fileId]);
  const file = rows[0];
  if (!file) return res.status(404).json({ message: 'File not found' });
  const siteId = await assertComplianceSiteAccess(req, res, file.site_id, { required: true });
  if (!siteId) return undefined;

  const existing = await model.findByLegacyFile(fileId, req.user.organization_id);
  if (existing) return res.json({ workbook_id: existing.id, existing: true });

  const sheets = validateSheetList(req.body?.sheets);
  const workbookId = await model.createWorkbook({
    user: req.user, siteId, name: cleanName(req.body?.name || file.name), sheets, settings: {},
    legacyFileId: fileId, versionAction: 'IMPORT',
  });
  const workbook = await model.findWorkbookForUser(req.user, workbookId);
  await audit(req, {
    action: 'WORKBOOK_IMPORTED', workbook,
    description: `Converted document "${file.name}" into an editable workbook`,
    metadata: { legacy_file_id: fileId, sheet_count: sheets.length },
  });
  return res.status(201).json({ workbook_id: workbookId, existing: false });
});

/** GET /spreadsheets/:id */
export const getWorkbook = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return undefined;
  const sheets = await model.loadSheets(access.workbook.id);
  const { share_level: _share, site_ok: _ok, ...workbook } = access.workbook;
  return res.json({ workbook: { ...workbook, access_level: access.level }, sheets, permissions: permissionsFor(access.level) });
});

/** PATCH /spreadsheets/:id — metadata only (name/description/settings/site/status). */
export const updateWorkbook = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const wantsOwnerFields = body.site_id !== undefined || body.status !== undefined;
  const access = await loadAccess(req, res, { minimum: wantsOwnerFields ? 'owner' : 'editor' });
  if (!access) return undefined;

  let siteId;
  if (body.site_id !== undefined) {
    siteId = await resolveSiteForCreate(req, res, body.site_id);
    if (siteId === false) return undefined;
  }
  if (body.status !== undefined && !['active', 'archived'].includes(body.status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }
  const name = body.name !== undefined ? cleanName(body.name, access.workbook.name) : undefined;
  const updated = await model.updateWorkbookMeta(access.workbook.id, {
    name,
    description: body.description !== undefined ? String(body.description).slice(0, 2000) : undefined,
    status: body.status,
    settings: body.settings && typeof body.settings === 'object' ? body.settings : undefined,
    siteId,
  }, req.user.id);
  if (name && name !== access.workbook.name) {
    await audit(req, {
      action: 'WORKBOOK_RENAMED', workbook: { ...access.workbook, name },
      description: `Renamed workbook "${access.workbook.name}" to "${name}"`,
      metadata: { previous_name: access.workbook.name },
    });
  }
  return res.json({ workbook: updated });
});

/** DELETE /spreadsheets/:id (soft) */
export const deleteWorkbook = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'owner' });
  if (!access) return undefined;
  await model.softDeleteWorkbook(access.workbook.id, req.user.id);
  await audit(req, { action: 'WORKBOOK_DELETED', workbook: access.workbook, description: `Deleted workbook "${access.workbook.name}"` });
  return res.json({ message: 'Workbook moved to trash' });
});

/** POST /spreadsheets/:id/restore */
export const restoreWorkbook = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { includeDeleted: true, minimum: 'owner' });
  if (!access) return undefined;
  await model.restoreWorkbook(access.workbook.id, req.user.id);
  await audit(req, { action: 'WORKBOOK_RESTORED', workbook: access.workbook, description: `Restored workbook "${access.workbook.name}"` });
  return res.json({ message: 'Workbook restored' });
});

/** POST /spreadsheets/:id/duplicate */
export const duplicateWorkbook = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return undefined;
  const newId = await model.duplicateWorkbook(access.workbook, req.user);
  const workbook = await model.findWorkbookForUser(req.user, newId);
  await audit(req, {
    action: 'WORKBOOK_CREATED', workbook,
    description: `Duplicated workbook "${access.workbook.name}"`, metadata: { source_workbook_id: access.workbook.id },
  });
  return res.status(201).json({ workbook: { ...workbook, access_level: 'owner' } });
});

/**
 * POST /spreadsheets/:id/changes — the autosave endpoint.
 * Body: { base_version, force, ops[], snapshots[], deleted_sheet_keys[], sheet_order{}, name, settings, version_label, events[] }
 */
export const saveChanges = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'editor' });
  if (!access) return undefined;
  const body = req.body || {};
  try {
    const groupedOps = groupOpsBySheet(body.ops || []);
    const rawSnapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
    if (rawSnapshots.length > 200) throw new SpreadsheetOpError('Too many sheet snapshots in one request', 413);
    const snapshots = rawSnapshots.map(sanitizeSheetSnapshot);
    const deletedSheetKeys = Array.isArray(body.deleted_sheet_keys)
      ? body.deleted_sheet_keys.filter((key) => typeof key === 'string').map((key) => key.slice(0, 64)).slice(0, 200)
      : [];
    const changes = {
      deletedSheetKeys,
      sheetOrder: body.sheet_order && typeof body.sheet_order === 'object' ? body.sheet_order : null,
      name: body.name !== undefined ? cleanName(body.name, access.workbook.name) : null,
      settings: body.settings && typeof body.settings === 'object' ? body.settings : null,
    };
    const baseVersion = Number.isInteger(body.base_version) ? body.base_version : null;
    const force = body.force === true && hasLevel(access.level, 'editor');
    const versionLabel = body.version_label ? String(body.version_label).trim().slice(0, 255) : null;

    const result = await model.applyChanges(access.workbook.id, {
      baseVersion, force, userId: req.user.id, changes, groupedOps, snapshots, versionLabel,
    });

    const events = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
    for (const event of events) {
      if (!event || !CLIENT_EVENTS.has(event.type)) continue;
      const detail = event.name ? ` "${String(event.name).slice(0, 120)}"` : '';
      await audit(req, {
        action: event.type, workbook: access.workbook,
        description: `${event.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (l) => l.toUpperCase())}${detail} in workbook "${access.workbook.name}"`,
        metadata: { sheet_key: event.sheet_key ? String(event.sheet_key).slice(0, 64) : undefined, previous_name: event.previous_name },
      });
    }
    if (changes.name && changes.name !== access.workbook.name) {
      await audit(req, {
        action: 'WORKBOOK_RENAMED', workbook: { ...access.workbook, name: changes.name },
        description: `Renamed workbook "${access.workbook.name}" to "${changes.name}"`,
      });
    }
    return res.json({ version: result.version, saved_at: new Date().toISOString() });
  } catch (error) {
    if (error instanceof SpreadsheetOpError) {
      return res.status(error.statusCode).json({
        message: error.message,
        code: error.statusCode === 409 ? 'VERSION_CONFLICT' : error.needsSnapshot ? 'SNAPSHOT_REQUIRED' : 'INVALID_CHANGES',
        server_version: error.serverVersion,
        needs_snapshot: error.needsSnapshot,
      });
    }
    throw error;
  }
});

/** GET /spreadsheets/:id/versions */
export const listVersions = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'editor' });
  if (!access) return undefined;
  return res.json({ versions: await model.listVersions(access.workbook.id), current_version: access.workbook.version });
});

/** GET /spreadsheets/:id/versions/:versionId */
export const getVersion = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'editor' });
  if (!access) return undefined;
  const versionId = parsePositiveId(req.params.versionId);
  const version = versionId ? await model.getVersion(access.workbook.id, versionId) : null;
  if (!version) return res.status(404).json({ message: 'Version not found' });
  return res.json({ version });
});

/** POST /spreadsheets/:id/versions — manual checkpoint of the saved state. */
export const createVersion = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'editor' });
  if (!access) return undefined;
  const label = String(req.body?.label || '').trim().slice(0, 255) || null;
  await model.createManualVersion(access.workbook.id, req.user.id, label);
  return res.status(201).json({ versions: await model.listVersions(access.workbook.id) });
});

/** POST /spreadsheets/:id/versions/:versionId/restore */
export const restoreVersion = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'owner' });
  if (!access) return undefined;
  const versionId = parsePositiveId(req.params.versionId);
  const version = versionId ? await model.getVersion(access.workbook.id, versionId) : null;
  if (!version) return res.status(404).json({ message: 'Version not found' });
  const sheets = validateSheetList(version.snapshot);
  const result = await model.replaceSheets(access.workbook.id, sheets, req.user.id, {
    action: 'RESTORE', label: `Restored version ${version.version}`,
  });
  await audit(req, {
    action: 'VERSION_RESTORED', workbook: access.workbook,
    description: `Restored workbook "${access.workbook.name}" to version ${version.version}`,
    metadata: { version_id: version.id, restored_version: version.version },
  });
  return res.json({ version: result.version, sheets });
});

/** GET /spreadsheets/:id/shares */
export const listShares = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'editor' });
  if (!access) return undefined;
  const shares = await model.listShares(access.workbook.id);
  const candidates = hasLevel(access.level, 'owner') ? await model.listShareCandidates(req.user.organization_id) : [];
  return res.json({ shares, candidates, owner_user_id: access.workbook.owner_user_id });
});

/** PUT /spreadsheets/:id/shares */
export const upsertShare = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'owner' });
  if (!access) return undefined;
  const userId = parsePositiveId(req.body?.user_id);
  const accessLevel = String(req.body?.access_level || '');
  if (!userId || !SHARE_LEVELS.has(accessLevel)) return res.status(400).json({ message: 'A user and a valid access level are required' });
  if (Number(access.workbook.owner_user_id) === userId) return res.status(400).json({ message: 'The owner already has full access' });
  const share = await model.upsertShare(access.workbook.id, {
    userId, accessLevel, createdBy: req.user.id, organizationId: req.user.organization_id,
  });
  if (!share) return res.status(404).json({ message: 'User not found in your organisation' });
  await audit(req, {
    action: 'PERMISSION_CHANGED', workbook: access.workbook,
    description: `Shared workbook "${access.workbook.name}" with user #${userId} as ${accessLevel}`,
    metadata: { target_user_id: userId, access_level: accessLevel },
  });
  return res.json({ share });
});

/** DELETE /spreadsheets/:id/shares/:userId */
export const deleteShare = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res, { minimum: 'owner' });
  if (!access) return undefined;
  const userId = parsePositiveId(req.params.userId);
  if (!userId) return res.status(400).json({ message: 'Invalid user' });
  await model.deleteShare(access.workbook.id, userId);
  await audit(req, {
    action: 'PERMISSION_CHANGED', workbook: access.workbook,
    description: `Removed user #${userId} from workbook "${access.workbook.name}"`,
    metadata: { target_user_id: userId, access_level: null },
  });
  return res.json({ message: 'Access removed' });
});

/** POST /spreadsheets/:id/export — the file is built client-side; this records the business event. */
export const recordExport = asyncHandler(async (req, res) => {
  const access = await loadAccess(req, res);
  if (!access) return undefined;
  const format = ['xlsx', 'csv', 'pdf'].includes(req.body?.format) ? req.body.format : 'xlsx';
  await audit(req, {
    action: 'WORKBOOK_EXPORTED', workbook: access.workbook,
    description: `Exported workbook "${access.workbook.name}" as ${format.toUpperCase()}`,
    metadata: { format, sheet: req.body?.sheet ? String(req.body.sheet).slice(0, 255) : undefined },
  });
  return res.status(204).end();
});
