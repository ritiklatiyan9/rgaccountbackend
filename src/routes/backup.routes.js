import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pool from '../config/db.js';
import authMiddleware from '../middlewares/auth.middleware.js';
import { createBackupAdminGuard } from '../middlewares/backupAdmin.middleware.js';
import { backupMaintenanceEnabled,beginBackupRestore,endBackupRestore } from '../middlewares/backupMaintenance.middleware.js';
import { clearCacheByPrefixes, incrementRateLimit } from '../config/cache.js';
import { getBackupLimits } from '../services/backupArchive.js';
import { getBackupCatalog, previewBackup, restoreBackup } from '../services/backup.service.js';
import { createNativeBackupRouter } from './nativeBackup.routes.js';
import { ATTACHMENT_PART_FORMAT, attachmentPartPreview, createAttachmentPartRestores, decodeBackupPart } from '../services/backupAttachmentParts.js';

const router = express.Router();
let running = false;
const upload = multer({
  storage: multer.diskStorage({ destination: (req,_file,done) => done(null,req.backupTempDir), filename: (_req,_file,done) => done(null,`${randomUUID()}.upload`) }),
  limits: { fileSize:getBackupLimits().maxUploadBytes, files:1, fields:5, fieldSize:256, parts:7 },
}).single('backup');

router.use(createNativeBackupRouter());
router.use(authMiddleware,createBackupAdminGuard(pool));

const attachmentRestores=createAttachmentPartRestores();

function startOperation(req,res,file=false) {
  const limit = incrementRateLimit(`${file ? 'backup-parts' : 'backups'}:${req.user.id}`, file ? 60*60*1000 : 10*60*1000);
  if (limit.count > (file ? 50000 : 30)) {
    res.setHeader('Retry-After',String(limit.ttlSeconds));
    res.status(429).json({ message:'Too many backup operations. Please wait before trying again.' });
    return false;
  }
  if (running) { res.status(409).json({ message:'Another backup operation is running. Please wait for it to finish.' }); return false; }
  running=true;
  return true;
}

function operation(handler, { file = false, restore = false } = {}) {
  return async (req,res) => {
    if (restore && !backupMaintenanceEnabled()) return res.status(409).json({ message:'Enable BACKUP_MAINTENANCE_MODE=true and restart the API before restoring. Stop all other applications and workers using this database.' });
    if (!startOperation(req,res,file)) return;
    try {
      if (file) {
        // mkdtemp creates a private 0700 directory BEFORE any sensitive bytes
        // reach disk; chmod after an upload alone would expose the partial file.
        req.backupTempDir = await fs.mkdtemp(path.join(os.tmpdir(),'accounts-backup-'));
        await new Promise((resolve,reject) => upload(req,res,error => error ? reject(error) : resolve()));
        if (!req.file) return res.status(400).json({ message:'Select a backup file to upload.' });
        await fs.chmod(req.file.path,0o600);
      }
      // The generic audit middleware records this small request/summary only;
      // the archive itself stays in a private temporary file, never req.body.
      await handler(req,res,file ? await fs.readFile(req.file.path) : null);
    } catch (error) {
      if (!res.headersSent) {
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof multer.MulterError ? 400 : (error.statusCode || 500);
        if (status >= 500) console.error('[backup] Operation failed:', error.code || error.name);
        res.status(status).json({ message:error.code === 'LIMIT_FILE_SIZE'
          ? `Backup exceeds the ${Math.floor(getBackupLimits().maxUploadBytes/1024/1024)} MB upload limit.`
          : status < 500 ? error.message : 'Backup operation failed. No successful restore was reported. Check server logs and verify the database before retrying.' });
      }
    } finally {
      if (req.backupTempDir) await fs.rm(req.backupTempDir,{ force:true,recursive:true }).catch(() => {});
      running = false;
    }
  };
}

// The former generator retained the database in the API heap. It is deliberately
// unreachable even for older clients. Native jobs are the only export path.
router.post(['/export','/exports'], (_req,res) => res.status(410).json({message:'Use the backup dashboard to create a durable native backup job.'}));
router.get(['/exports/:id','/exports/:id/file'], (_req,res) => res.status(410).json({message:'Temporary exports are retired. Use Backup History for native archives.'}));
router.use((req,res,next) => {
  if (process.env.BACKUP_LEGACY_RESTORE_ENABLED !== 'true') return res.status(409).json({message:'Legacy JSON imports are disabled. Use isolated native restore verification or the recovery runbook.'});
  next();
});
router.get('/catalog',operation(async (_req,res) => res.json({...await getBackupCatalog(pool),exportJobs:false,attachmentParts:true})));
router.post('/preview',operation(async (_req,res,buffer) => {
  const decoded=await decodeBackupPart(buffer);
  res.json(decoded.format===ATTACHMENT_PART_FORMAT ? attachmentPartPreview(decoded) : await previewBackup(pool,buffer,{decodedArchive:decoded}));
},{ file:true }));
router.post('/restore',createBackupAdminGuard(pool,'restore'),operation(async (req,res,buffer) => {
  if (req.body.maintenanceAcknowledged !== 'true') return res.status(400).json({ message:'Confirm that other connected applications and external workers have been stopped.' });
  if (!beginBackupRestore()) return res.status(409).json({ message:'A sign-in or restore is still running. Wait a moment and try again.' });
  try {
    const decoded=await decodeBackupPart(buffer);
    if(decoded.format===ATTACHMENT_PART_FORMAT) {
      if(req.body.confirmation!=='RESTORE' || req.body.checksum!==decoded.checksum) return res.status(400).json({message:'Validate this attachment part and confirm RESTORE before uploading it.'});
      return res.json({...await attachmentRestores.restore(req.user.id,decoded),message:'Attachment part verified. Database records have not been restored yet.'});
    }
    const result = await restoreBackup(pool,buffer,req.body,{
      decodedArchive:decoded,
      verifyAttachmentSet:(set,checksum)=>attachmentRestores.assertComplete(req.user.id,set.backupId,checksum,set.requiredFileIds),
    });
    // Cache failure must never misreport a committed restore as a failed one.
    await clearCacheByPrefixes(['*']).catch(error => console.error('[backup] Cache clear failed:',error.name));
    res.json(result);
  } finally { endBackupRestore(); }
},{ file:true, restore:true }));

export default router;
