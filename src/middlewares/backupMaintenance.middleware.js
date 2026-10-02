export const backupMaintenanceEnabled = () => process.env.BACKUP_MAINTENANCE_MODE === 'true';

const loginPaths = new Set(['/auth/login','/auth/google','/auth/google/status','/auth/verify-otp','/auth/resend-otp','/auth/refresh','/auth/logout','/auth/me']);
let restoring = false;
let authenticationRequests = 0;

export function beginBackupRestore() {
  if (restoring || authenticationRequests > 0) return false;
  restoring = true;
  return true;
}
export function endBackupRestore() { restoring = false; }

export default function backupMaintenanceMiddleware(req, res, next) {
  if (restoring && req.method !== 'OPTIONS' && req.path !== '/') {
    res.setHeader('Retry-After','30');
    return res.status(503).json({ code:'BACKUP_RESTORE_RUNNING',message:'A database restore is running. Wait for it to finish before signing in or making another request.' });
  }
  if (backupMaintenanceEnabled() && loginPaths.has(req.path)) {
    authenticationRequests += 1;
    let finished = false;
    const complete = () => { if (!finished) { finished = true; authenticationRequests -= 1; } };
    res.once('finish',complete);
    res.once('close',complete);
  }
  if (!backupMaintenanceEnabled() || req.method === 'OPTIONS' || req.path === '/' || req.path === '/backups' || req.path.startsWith('/backups/') || loginPaths.has(req.path)) return next();
  res.setHeader('Retry-After','60');
  return res.status(503).json({ code:'BACKUP_MAINTENANCE', message:'The account software is in backup maintenance mode. Normal work will resume when the administrator finishes the restore.' });
}
