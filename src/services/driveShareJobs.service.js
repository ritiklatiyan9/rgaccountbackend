import pool from '../config/db.js';
import { createHash } from 'node:crypto';
import { emitToUser } from '../config/socket.js';
import { resolveEntryVisibility } from './entryVisibility.service.js';
import permissionModel from '../models/Permission.model.js';
import { assertCommissionSite } from '../controllers/plotCommissionV2.controller.js';
import { createShareProgress, createPreparedBundleCache, uploadPercent } from './driveShareProgress.js';
import { sameEntryVisibility } from './driveShareVisibility.js';
import { generatedContentHash, logicalFileKey, shareSyncSummary } from './driveShareSync.js';
import { existingShareFolderSegments, existingModuleShareFolderSegments } from './driveShareDestination.service.js';
import { getModuleDriveDefinition, assertModuleDriveAccess, buildModuleDriveShareBundle, planModuleDriveShareFiles } from './moduleDriveShare.service.js';
import { buildModuleShareXlsx, renderModuleShareHtml, moduleShareProjection } from './driveShareWorkbook.service.js';
import { prepareDriveDocumentLinks } from './driveDocumentLinks.service.js';
import {
  driveClientFor, ensureSiteFolder, ensureFolderPath, ensureSubfolders, listChildren, upsertFile, exportPdf,
  folderPathKey, folderUrl, tryPlotShareLock, translateDriveError, markReauthorizationRequired, MODULE_ROOT_NAME,
} from './googleDrive.service.js';
import {
  buildPlotCommissionShareBundle, renderStatementHtml, renderProfileHtml, buildStatementXlsx, planShareFiles, readStoredFileBytes, plotShareDocumentSources,
} from './plotCommissionShare.service.js';

/**
 * Background Drive shares. A share request only inserts a `queued` row in
 * google_drive_shares and answers at once; this runner picks rows up, uploads,
 * and streams progress to the requesting user's sockets (`drive_share:progress`,
 * `drive_share:done`). The table IS the queue: no broker, and rows still
 * queued/running after a restart are simply picked up again — every upload is
 * an upsert by name, so re-running a half-finished share is safe.
 * ponytail: single-instance runner (like cache.js and the schedulers); move to
 * SQS + a worker if the API ever scales out.
 */

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_SHARE_BYTES = 150 * 1024 * 1024;
// Drive calls are latency-bound (~0.5 s each); a few in flight per share cuts
// minutes to seconds without tripping Drive's per-user rate limit.
const UPLOAD_CONCURRENCY = 4;
const JOB_CONCURRENCY = 2;
const SWEEP_MS = 15000;
const preparedBundles = createPreparedBundleCache();
const SHARE_FIELDS = `id, organization_id, site_id, module, entity_type, entity_id, payment_id, scope, label, folder_path, folder_id, folder_url,
  files, status, error, progress, request, shared_by, created_at, started_at, finished_at`;

const runLimited = async (tasks, limit) => {
  let next = 0;
  const worker = async () => { while (next < tasks.length) await tasks[next++](); };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Google's message ("File not found: 1abc…", "The user's Drive storage quota
// has been exceeded") is safe to show; internal errors get the generic text.
const isGoogleError = (err) => Boolean(err?.response?.data?.error || err?.errors);
const shortReason = (err) => (err?.code === 'UNSUPPORTED_STORAGE' ? 'Stored outside the app bucket'
  : err?.code === 'FILE_TOO_LARGE' ? err.message
    : isGoogleError(err) && err.message ? `Google Drive: ${String(err.message).slice(0, 160)}`
      : translateDriveError(err).message);

/** Drive is eventually consistent for just-created folders: a 404 on a parent
 * created seconds ago usually clears itself. Retry briefly before giving up. */
const withDriveRetry = async (fn, { attempts = 3, delayMs = 750, onRetry } = {}) => {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const status = Number(err?.status ?? err?.response?.status ?? err?.code);
      if (![404, 429, 500, 502, 503].includes(status) || i === attempts - 1) throw err;
      onRetry?.(i + 1);
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
};

/** Builds the upload tasks for one planned item; every finished unit (a Doc,
 * a PDF, a sheet, a document) is handed to `report`. */
const uploadTasks = ({ ctx, bundle, share, visibility, item, parentId, existing, budget, report, activity }) => {
  const base = { folder: item.folder, name: item.name, kind: item.kind, mime_type: null, drive_file_id: null, url: null, error: null };
  const spend = (bytes) => {
    if (budget.used + bytes > MAX_SHARE_BYTES) throw Object.assign(new Error('Share size limit reached'), { code: 'FILE_TOO_LARGE' });
    budget.used += bytes;
  };
  const failed = (name, err) => {
    console.error(`[gdrive] upload of "${name}" failed:`, err?.response?.data?.error || err?.message || err);
    return { ...base, name, action: 'failed', error: shortReason(err) };
  };
  const put = async (name, mimeType, body, convertTo, format = 'binary') => {
    const bytes = Buffer.byteLength(body);
    spend(bytes);
    const contentHash = format === 'binary' ? createHash('sha256').update(body).digest('hex')
      : item.kind === 'module_report' ? createHash('sha256').update(JSON.stringify({ version: 1, format, content: moduleShareProjection(bundle) })).digest('hex')
        : generatedContentHash(bundle, item, format);
    const syncKey = logicalFileKey({ share, item, format, visibility });
    const named = existing.get(name);
    const candidate = existing.bySyncKey?.get(syncKey) || (
      named?.appProperties?.dg_sync_key === syncKey || (visibility.canViewAll && !named?.appProperties?.dg_sync_key) ? named : null
    );
    let attempt = 0;
    const file = await withDriveRetry(() => {
      activity(name, { stage: 'checking', bytes_sent: 0, bytes_total: bytes });
      return upsertFile(ctx, {
        // A timeout/5xx can arrive after Drive saved the file. Re-list on
        // retries so replay updates that file instead of creating a duplicate.
        parentId, name, mimeType, body, convertTo, contentHash, syncKey, allowLegacyMatch: visibility.canViewAll,
        existing: attempt++ === 0 ? candidate || null : undefined,
        onUploadProgress: (progress) => activity(name, { stage: 'uploading', ...progress }, true),
      });
    }, { onRetry: () => activity(name, { stage: 'retrying', bytes_sent: 0, bytes_total: bytes }) });
    return { record: { ...base, name, mime_type: file.mime_type || convertTo || mimeType, drive_file_id: file.id, url: file.url,
      action: file.action || (file.created ? 'created' : 'updated') }, created: file.created };
  };

  if (item.kind === 'document' || item.kind === 'voucher' || item.kind === 'signature') {
    return [async () => {
      try {
        activity(item.name, { stage: 'downloading', bytes_sent: 0, bytes_total: item.size || 0 });
        const { bytes, mime_type } = await readStoredFileBytes(item.source);
        report((await put(item.name, item.mime_type || mime_type, bytes)).record);
      } catch (err) {
        report(failed(item.name, err));
      }
    }];
  }

  const tasks = [];
  const wantDoc = item.formats.includes('doc');
  const wantPdf = item.formats.includes('pdf');
  if (wantDoc || wantPdf) {
    tasks.push(async () => {
      let doc = null;
      try {
        activity(item.name, { stage: 'preparing' });
        const html = item.kind === 'module_report' ? renderModuleShareHtml(bundle, { preview: false }) : item.kind === 'profile' ? renderProfileHtml(bundle) : renderStatementHtml(bundle);
        doc = await put(item.name, 'text/html', html, GOOGLE_DOC, 'doc');
        if (wantDoc) report(doc.record);
        else activity(item.name, null);
      } catch (err) {
        activity(item.name, null);
        if (wantDoc) report(failed(item.name, err));
        if (wantPdf) report(failed(`${item.name}.pdf`, err));
        return;
      }
      if (!wantPdf) return;
      try {
        activity(`${item.name}.pdf`, { stage: 'converting' });
        report((await put(`${item.name}.pdf`, 'application/pdf', await withDriveRetry(() => exportPdf(ctx, doc.record.drive_file_id)), undefined, 'pdf')).record);
      } catch (err) {
        report(failed(`${item.name}.pdf`, err));
      }
      // A Doc created only as this PDF's conversion source is dropped again; one
      // an earlier share created (and this request merely refreshed) stays put.
      if (!wantDoc && doc.created) await ctx.drive.files.delete({ fileId: doc.record.drive_file_id }).catch(() => {});
    });
  }
  if (['statement', 'module_report'].includes(item.kind) && item.formats.includes('xlsx')) {
    tasks.unshift(async () => {
      try {
        activity(`${item.name}.xlsx`, { stage: 'preparing' });
        report((await put(`${item.name}.xlsx`, XLSX_MIME, item.kind === 'module_report' ? buildModuleShareXlsx(bundle) : buildStatementXlsx(bundle), undefined, 'xlsx')).record);
      } catch (err) {
        report(failed(`${item.name}.xlsx`, err));
      }
    });
  }
  return tasks;
};

const unitsOf = (item) => (item.formats ? item.formats.length : 1);

const summarizeFailures = (files) => {
  const failed = files.filter((f) => f.error);
  if (!failed.length) return null;
  const names = failed.slice(0, 5).map((f) => f.name).join(', ');
  return `${failed.length} of ${files.length} files skipped: ${names}${failed.length > 5 ? ', …' : ''}`;
};

export const getShareRow = async (id) => {
  const { rows } = await pool.query(`SELECT ${SHARE_FIELDS} FROM google_drive_shares WHERE id=$1`, [id]);
  return rows[0] || null;
};

const publish = (share, event) => {
  if (share.shared_by) emitToUser(share.shared_by, event, share);
};

const progressFor = (share) => createShareProgress({
  initial: share.progress,
  publish: (progress) => {
    share.progress = progress;
    publish(share, 'drive_share:progress');
  },
  persist: (progress) => pool.query(
    "UPDATE google_drive_shares SET progress=$1::jsonb WHERE id=$2 AND status='running'",
    [JSON.stringify(progress), share.id],
  ),
  onError: (err) => console.error('[gdrive] progress update failed:', err.message),
});

const finish = async (share, reporter, { status, files, error, folderId }) => {
  // Drain in-flight progress writes before persisting the terminal state.
  const last = await reporter.stop();
  const sync = shareSyncSummary(files);
  const progress = {
    ...last, sequence: last.sequence + 1, phase: status,
    label: status === 'completed' ? (sync.unchanged === files.length ? 'Already up to date' : 'Shared to Google Drive') : status === 'partial' ? 'Shared with some files skipped' : 'Sharing failed',
    percent: status === 'failed' ? last.percent : 100,
    sync, active_files: [], updated_at: new Date().toISOString(),
  };
  const { rows } = await pool.query(
    `UPDATE google_drive_shares
        SET status=$2, files=$3::jsonb, error=$4, folder_id=COALESCE($5, folder_id), folder_url=COALESCE($6, folder_url),
            progress=$7::jsonb, folder_path=$8, finished_at=NOW()
      WHERE id=$1 RETURNING ${SHARE_FIELDS}`,
    [share.id, status, JSON.stringify(files), error, folderId || null, folderId ? folderUrl(folderId) : null, JSON.stringify(progress), share.folder_path],
  );
  publish(rows[0], 'drive_share:done');
  return rows[0];
};

/** Runs one queued share to completion. Never throws: every outcome lands in the row. */
export const runShareJob = async (share) => {
  const orgId = share.organization_id;
  const req = share.request || {};
  const siteId = Number(share.site_id);
  const plotId = Number(share.entity_id);
  const generic = Boolean(share.module && share.module !== 'plot_commission');
  const definition = generic ? getModuleDriveDefinition(share.module) : null;
  const reporter = progressFor(share);
  const finishJob = (result) => finish(share, reporter, result);
  let lock = null;
  try {
    if (generic && !definition) throw Object.assign(new Error('This sharing module is no longer available'), { statusCode: 400 });
    lock = generic ? await tryPlotShareLock(orgId, plotId, { module: share.module, entityType: share.entity_type, siteId }) : await tryPlotShareLock(orgId, plotId);
    if (!lock) {
      // A different process is sharing this plot; the periodic sweep retries.
      await pool.query("UPDATE google_drive_shares SET status='queued', started_at=NULL WHERE id=$1", [share.id]);
      return { deferred: true };
    }
    reporter.update({ phase: 'preparing', percent: 3, label: 'Checking Drive connection and reading records' });
    const [ctx, { rows: [user] }] = await Promise.all([
      driveClientFor(orgId),
      pool.query('SELECT id, role, email, organization_id, is_active FROM users WHERE id=$1', [share.shared_by]),
    ]);
    if (!ctx) return await finishJob({ status: 'failed', files: [], error: 'Google Drive is not connected' });
    if (!user) return await finishJob({ status: 'failed', files: [], error: 'The user who requested this share no longer exists' });
    if (user.is_active === false || !['admin', 'super_admin', 'sub_admin'].includes(user.role)) {
      return await finishJob({ status: 'failed', files: [], error: 'The user no longer has access to share records' });
    }
    if (user.organization_id != null && Number(user.organization_id) !== Number(orgId)) {
      return await finishJob({ status: 'failed', files: [], error: 'Organization access is no longer available' });
    }
    if (!generic) {
      if (user.role === 'sub_admin' && (await permissionModel.getPermission(user.id, 'commissions'))?.can_read !== true) {
        return await finishJob({ status: 'failed', files: [], error: 'Read permission for commissions is no longer available' });
      }
      await assertCommissionSite(user, siteId);
    }
    const entryVisibility = generic ? await assertModuleDriveAccess({ moduleKey: share.module, siteId, user }) : await resolveEntryVisibility(user, 'commissions');
    if ((!generic && !entryVisibility.canViewAll && share.scope !== 'transaction') || (generic && req.visibility
      && !sameEntryVisibility(req.visibility, entryVisibility))) {
      return await finishJob({ status: 'failed', files: [], error: 'Permission to share the full statement is no longer available' });
    }
    const includeDocuments = req.include_documents === true;
    const bundle = preparedBundles.take(share.id, entryVisibility) || await (generic ? buildModuleDriveShareBundle({
      moduleKey: share.module, entityId: req.record_id || null, siteId, user, entryVisibility, scope: share.scope,
    }) : buildPlotCommissionShareBundle({ plotId, siteId, user, entryVisibility, scope: share.scope,
      paymentId: share.payment_id ? Number(share.payment_id) : null, includeDocuments, includeDocumentLinks: true }));
    const plan = generic ? planModuleDriveShareFiles(bundle, { formats: req.formats }) : planShareFiles(bundle, { scope: share.scope, formats: req.formats, includeDocuments, documentMode: includeDocuments ? 'copies' : 'links' });
    const active = plan.filter((f) => !f.skipped_reason);
    const total = active.reduce((n, f) => n + unitsOf(f), 0);
    let done = 0;
    reporter.update({ phase: 'folders', percent: 10, done, total, files_done: done, files_total: total, label: 'Preparing site folder' });
    if (!total) return await finishJob({ status: 'failed', files: [], error: 'No files are available for this selection' });

    let baseId = null;
    let subfolders;
    let children;
    try {
      // The site folder carries the CA's grant; everything below inherits it.
      const siteFolder = await ensureSiteFolder(ctx, { id: siteId, name: bundle.site.name });
      reporter.update({ percent: 18, label: 'Preparing record folder' });
      bundle.folderSegments = await (generic ? existingModuleShareFolderSegments({ orgId, siteId, moduleKey: share.module,
        entityType: share.entity_type, entityId: plotId, moduleLabel: bundle.moduleLabel, rootFolderId: ctx.connection?.root_folder_id }, bundle.folderSegments)
        : existingShareFolderSegments({ orgId, siteId, plotId, rootFolderId: ctx.connection?.root_folder_id }, bundle.folderSegments));
      baseId = await ensureFolderPath(ctx, bundle.folderSegments, { base: siteFolder });
      share.folder_id = baseId;
      share.folder_url = folderUrl(baseId);
      share.folder_path = folderPathKey([ctx.connection?.root_folder_name || MODULE_ROOT_NAME, bundle.siteFolderName || bundle.site.name, ...bundle.folderSegments]);
      reporter.update({ percent: 25, label: 'Preparing destination folders' });
      const groups = [...new Set(active.map((f) => f.folder))];
      subfolders = await ensureSubfolders(ctx, { id: baseId, key: folderPathKey([siteFolder.key, ...bundle.folderSegments]) }, groups);
      reporter.update({ percent: 30, label: 'Checking existing files' });
      // One listing per subfolder replaces a lookup per file.
      children = new Map(await Promise.all(groups.map(async (g) => [g, await withDriveRetry(() => listChildren(ctx, subfolders.get(g)))])));
      // Folder repair can change both the root and inherited CA permission IDs.
      // Mint capabilities against those final grants, including cached POST bundles.
      const sources = generic ? bundle.documentSources || [] : plotShareDocumentSources(bundle);
      if (sources.length) {
        reporter.update({ percent: 32, label: 'Checking access to linked documents' });
        const links = await prepareDriveDocumentLinks({ orgId, siteId, documents: sources });
        if (generic) bundle.documents = links;
        else bundle.documentLinks = links;
      }
    } catch (err) {
      console.error(`[gdrive] share ${share.id}: folder setup failed:`, err?.response?.data?.error || err);
      if (/invalid_grant/.test(String(err?.message))) await markReauthorizationRequired(orgId).catch(() => {});
      return await finishJob({ status: 'failed', files: [], error: shortReason(err), folderId: baseId });
    }
    reporter.update({ phase: 'uploading', percent: 35, label: 'Folders ready' });

    // Results land in plan order whatever the completion order.
    const slots = plan.map(() => []);
    const budget = { used: 0 };
    const tasks = [];
    const activeFiles = new Map();
    const labels = { preparing: 'Creating', checking: 'Checking for changes', downloading: 'Reading attachment', uploading: 'Uploading', converting: 'Converting PDF', retrying: 'Retrying upload' };
    plan.forEach((item, i) => {
      if (item.skipped_reason) {
        slots[i].push({ folder: item.folder, name: item.name, kind: item.kind, mime_type: item.mime_type || null, drive_file_id: null, url: null, action: 'failed', error: item.skipped_reason });
        return;
      }
      const activity = (name, detail, throttle = false) => {
        const key = `${item.folder}/${name}`;
        if (detail) activeFiles.set(key, { name, ...detail });
        else activeFiles.delete(key);
        const current = [...activeFiles.values()];
        reporter.update({
          active_files: current, percent: uploadPercent(done, total, current),
          ...(detail ? { label: `${labels[detail.stage] || 'Processing'} ${name}` } : {}),
        }, { throttle });
      };
      const report = (record) => {
        slots[i].push(record);
        activeFiles.delete(`${item.folder}/${record.name}`);
        done += 1;
        const current = [...activeFiles.values()];
        reporter.update({
          done, total, files_done: done, files_total: total, active_files: current,
          percent: uploadPercent(done, total, current), label: record.error ? `Skipped ${record.name}` : record.action === 'unchanged' ? `Unchanged ${record.name}` : `${record.action === 'updated' ? 'Updated' : 'Uploaded'} ${record.name}`,
        });
      };
      tasks.push(...uploadTasks({ ctx, bundle, share, visibility: entryVisibility, item, parentId: subfolders.get(item.folder), existing: children.get(item.folder), budget, report, activity }));
    });
    await runLimited(tasks, UPLOAD_CONCURRENCY);
    reporter.update({ phase: 'finalizing', percent: 98, active_files: [], label: 'Saving share result' });
    const files = slots.flat();
    const uploaded = files.filter((f) => !f.error).length;
    const status = uploaded === 0 ? 'failed' : uploaded === files.length ? 'completed' : 'partial';
    return await finishJob({ status, files, error: summarizeFailures(files), folderId: baseId });
  } catch (err) {
    console.error(`[gdrive] share ${share.id} crashed:`, err);
    return await finishJob({ status: 'failed', files: [], error: err?.statusCode ? err.message : translateDriveError(err).message })
      .catch((dbErr) => console.error('[gdrive] could not record share failure:', dbErr.message));
  } finally {
    await reporter.stop();
    if (lock) await lock.release().catch(() => {});
  }
};

// ---------------------------------------------------------------------------
// Runner

let running = 0;
let sweeping = false;
let timer = null;

const claimNext = async (limit) => {
  const { rows } = await pool.query(
    `UPDATE google_drive_shares s SET status='running', started_at=NOW()
      WHERE s.id IN (
        SELECT id FROM google_drive_shares WHERE status='queued' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
      ) RETURNING ${SHARE_FIELDS}`,
    [limit],
  );
  return rows;
};

/** Picks up queued shares until the concurrency cap is full. Safe to call often. */
export const kickShareRunner = async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    // Claim at most one batch per kick. A busy plot can be requeued before
    // this sweep finishes; looping here would reclaim it in a tight loop.
    if (running < JOB_CONCURRENCY) {
      const claimed = await claimNext(JOB_CONCURRENCY - running);
      for (const share of claimed) {
        running += 1;
        let deferred = false;
        runShareJob(share).then((result) => { deferred = result?.deferred === true; })
          .catch((err) => console.error('[gdrive] share job failed:', err.message)).finally(() => {
          running -= 1;
          if (!deferred) setImmediate(() => { kickShareRunner().catch(() => {}); });
        });
      }
    }
  } catch (err) {
    // Before migration 190 the status/progress columns do not exist; stay quiet until it runs.
    if (!['42P01', '42703'].includes(err.code)) console.error('[gdrive] share runner sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
};

/** Boot: shares left `running` by a previous process restart are re-queued, then the sweep timer starts. */
export const startDriveShareRunner = () => {
  pool.query("UPDATE google_drive_shares SET status='queued', started_at=NULL WHERE status='running'")
    .catch((err) => { if (!['42P01', '42703'].includes(err.code)) console.error('[gdrive] could not requeue interrupted shares:', err.message); })
    .then(() => kickShareRunner());
  timer = setInterval(() => { kickShareRunner().catch(() => {}); }, SWEEP_MS);
  timer.unref?.();
};

export const stopDriveShareRunner = () => { if (timer) clearInterval(timer); timer = null; };

/** Inserts a queued share and nudges the runner. Returns the row. */
export const enqueueShare = async ({ orgId, siteId, plotId, moduleKey = 'plot_commission', entityType = 'plot', entityId = plotId, paymentId, scope, label, folderPath, request, userId, prepared }) => {
  const { rows } = await pool.query(
    `INSERT INTO google_drive_shares
       (organization_id, site_id, module, entity_type, entity_id, payment_id, scope, label, folder_path, files, status, request, shared_by)
     VALUES ($1, $2, $10, $11, $3, $4, $5, $6, $7, '[]'::jsonb, 'queued', $8::jsonb, $9)
     RETURNING ${SHARE_FIELDS}`,
    [orgId, siteId, entityId, paymentId || null, scope, label, folderPath, JSON.stringify(request), userId, moduleKey, entityType],
  );
  if (prepared) preparedBundles.put(rows[0].id, prepared.bundle, prepared.entryVisibility);
  setImmediate(() => { kickShareRunner().catch(() => {}); });
  return rows[0];
};
