import express from 'express';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import { createBackupAdminGuard } from '../middlewares/backupAdmin.middleware.js';
import { incrementRateLimit } from '../config/cache.js';
import { getNativeBackupConfig } from '../services/nativeBackupConfig.js';
import { createNativeBackupStorage } from '../services/nativeBackupStorage.js';
import { createNativeBackupJobs, publicNativeBackupJob } from '../services/nativeBackupJobs.js';

const invalid = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function createNativeBackupRouter({ db = pool, config = getNativeBackupConfig(), storage, authenticate = authMiddleware } = {}) {
  const router = express.Router();
  const jobs = createNativeBackupJobs(db, config);
  let objectStorage = storage;
  const getStorage = () => objectStorage ||= createNativeBackupStorage(config);
  router.use(authenticate, createBackupAdminGuard(db));

  const action = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const status = error.code === '42P01' || error.code === '3F000' ? 503 : error.statusCode || 500;
      if (status >= 500) console.error('[native-backup-api]', { code: error.code || error.name, action: req.method });
      if (!res.headersSent) res.status(status).json({
        message: status === 503 ? 'Backup service is not installed or temporarily unavailable. Ask an administrator to check the worker and migration.'
          : status < 500 ? error.message : 'Backup operation failed. Retry shortly or ask an administrator to check the job diagnostics.',
        code: /^[A-Z0-9_]{1,64}$/.test(error.code || '') ? error.code : 'BACKUP_OPERATION_FAILED',
      });
    }
  };
  const enabled = () => { if (!config.enabled) throw invalid('Configure private backup storage and start the backup worker before creating jobs.', 503); };
  const rateLimit = req => {
    const limit = incrementRateLimit(`native-backups:${req.user.id}`, 10 * 60 * 1000);
    if (limit.count > 30) throw invalid('Too many backup operations. Wait before trying again.', 429);
  };
  const writable = req => {
    enabled();
    if (process.env.BACKUP_MAINTENANCE_MODE === 'true') throw invalid('Backup creation is paused during database maintenance.',409);
    rateLimit(req);
  };

  router.get('/jobs', action(async (_req, res) => {
    const history = await jobs.list();
    res.json({ jobs: history.map(publicNativeBackupJob), retentionDays: config.retentionDays,
      storage: config.storageDestination || 'Private S3',
      restore: { enabled: Boolean(config.restoreDatabaseUrl), targetLabel: config.restoreTargetLabel || 'Isolated verification database' },
      capabilities: { enabled: config.enabled === true, files: config.filesEnabled === true, legacyRestore: process.env.BACKUP_LEGACY_RESTORE_ENABLED === 'true' },
    });
  }));
  router.post('/jobs', action(async (req, res) => {
    writable(req);
    if (Object.keys(req.body || {}).some(key => key !== 'scope')) throw invalid('Only the backup scope may be supplied.');
    const scope = req.body?.scope || 'database';
    if (scope === 'database-files' && !config.filesEnabled) throw invalid('Original files require an immutable storage policy and retention configuration before they can be included.', 409);
    res.status(202).json(publicNativeBackupJob(await jobs.enqueue(req.user.id, { scope })));
  }));
  router.get('/jobs/:id', action(async (req, res) => res.json(publicNativeBackupJob(await jobs.get(req.params.id)))));
  router.post('/jobs/:id/cancel', action(async (req, res) => {
    rateLimit(req);
    res.json(publicNativeBackupJob(await jobs.cancel(req.params.id, req.user.id)));
  }));
  router.post('/jobs/:id/retry', action(async (req, res) => {
    writable(req);
    const existing = await jobs.get(req.params.id);
    // A view-only delegate must never retry a privileged restore-test job.
    if (existing.kind === 'restore-test') throw invalid('Start a new restore verification using the protected restore action.', 409);
    if (existing.scope === 'database-files' && !config.filesEnabled) throw invalid('File backup storage policy is no longer enabled.', 409);
    res.status(202).json(publicNativeBackupJob(await jobs.retry(req.params.id, req.user.id)));
  }));
  router.post('/jobs/:id/download', action(async (req, res) => {
    enabled(); rateLimit(req);
    const current = await jobs.get(req.params.id);
    if (current.kind !== 'backup' || current.status !== 'completed' || current.verificationStatus !== 'verified' || !current.artifactKey) throw invalid('This backup is not available for download.', 409);
    if (Object.keys(req.body || {}).some(key => !['artifact','fileId'].includes(key))) throw invalid('Choose a supported backup artifact.');
    const artifact = req.body?.artifact || 'database';
    if (!['database','manifest','files-manifest','file'].includes(artifact)) throw invalid('Choose a supported backup artifact.');
    if (['files-manifest','file'].includes(artifact) && current.scope !== 'database-files') throw invalid('This backup contains database records only.',409);
    let artifactKey = current.artifactKey;
    if (artifact === 'manifest') artifactKey = current.manifestKey;
    if (artifact === 'files-manifest') artifactKey = `${current.artifactPrefix}files.ndjson`;
    if (artifact === 'file') artifactKey = (await jobs.file(current.id,req.body?.fileId)).artifactKey;
    const download = await getStorage().presign({ ...current,artifactKey });
    // Persist before releasing a bearer capability. Never log the signed URL.
    await jobs.audit(current.id, req.user.id, 'download-authorized', { artifact, ...(artifact === 'file' ? { fileId:req.body.fileId } : {}) });
    res.json(download);
  }));
  router.post('/jobs/:id/restore-test', createBackupAdminGuard(db, 'restore'), action(async (req, res) => {
    writable(req);
    if (req.body?.confirmation !== 'VERIFY RESTORE') throw invalid('Type VERIFY RESTORE to confirm the isolated restoration test.');
    if (Object.keys(req.body || {}).some(key => key !== 'confirmation')) throw invalid('The restore target is configured by the administrator and cannot be supplied in a request.');
    res.status(202).json(publicNativeBackupJob(await jobs.enqueue(req.user.id, { kind: 'restore-test', sourceJobId: req.params.id })));
  }));
  return router;
}

export default createNativeBackupRouter;
