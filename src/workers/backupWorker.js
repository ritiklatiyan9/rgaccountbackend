import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getNativeBackupConfig } from '../services/nativeBackupConfig.js';
import { createNativeBackupJobs } from '../services/nativeBackupJobs.js';
import { createNativeBackupStorage } from '../services/nativeBackupStorage.js';
import { executeNativeBackup, executeRestoreVerification } from '../services/nativeBackupEngine.js';
import { sharedBackupMemory, backupBudgetAllowsStart, backupBudgetRequiresAbort } from '../services/backupResourceBudget.js';
import { nativeVersion } from '../services/nativeBackupProcess.js';

// Share the legacy restore lock: maintenance must stop this worker before import.
const LOCK = [734921, 1];
const safeCode = error => /^[A-Z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'BACKUP_WORKER_ERROR';

/** Exactly one worker owns the session lock across recovery, extraction and cleanup.
 * Leases fence publication if the lock connection or metadata connection is lost.
 */
export async function runBackupWorker({ config = getNativeBackupConfig(), pool, storage, signal, log = value => console.log(JSON.stringify(value)), once = false,
  backup = executeNativeBackup, restore = executeRestoreVerification, memory = sharedBackupMemory } = {}) {
  if (!config.enabled) throw new Error('Enable and configure private backup storage before starting the worker.');
  const ownedPool = !pool;
  pool ||= new pg.Pool({ ...config.database, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, application_name: 'accounts-backup-metadata' });
  storage ||= createNativeBackupStorage(config);
  const store = createNativeBackupJobs(pool, config);
  const workerId = randomUUID();
  let lock; let active; let stopped = false;
  const stop = () => { stopped = true; active?.abort(new Error('Worker stopping.')); };
  const lost = () => { stop(); log({ event: 'backup-lock-lost', workerId }); };
  signal?.addEventListener('abort', stop, { once: true });
  pool.on('error', lost);
  try {
    lock = await pool.connect();
    lock.on('error', lost);
    const { rows: [result] } = await lock.query('SELECT pg_try_advisory_lock($1,$2) AS acquired', LOCK);
    if (!result.acquired) { log({ event: 'backup-worker-standby', workerId }); return; }
    log({ event: 'backup-worker-ready', workerId });
    do {
      if (signal?.aborted || stopped) break;
      if (config.shared) {
        const budget = await memory();
        if (!backupBudgetAllowsStart(budget)) {
          // Recycle retained allocator pages between attempts. The supervisor
          // restarts a clean process while durable jobs remain queued.
          if (once || budget.rss >= 128 * 1024 ** 2 || backupBudgetRequiresAbort(budget)) break;
          await delay(5000, null, { signal }).catch(() => {}); continue;
        }
      }
      await store.recover();
      for (const attempt of await store.cleanupCandidates()) {
        if (stopped) break;
        try {
          await storage.removePrefix(attempt.artifactPrefix, { signal });
          await store.markAttemptCleaned(attempt.jobId, attempt.attempt);
        } catch (error) { log({ event: 'backup-cleanup-failed', jobId: attempt.jobId, code: safeCode(error) }); }
      }
      if (signal?.aborted || stopped) break;
      const job = await store.claim(workerId);
      if (!job) {
        if (once) break;
        await delay(config.pollMs, null, { signal }).catch(() => {});
        continue;
      }
      if (signal?.aborted || stopped) {
        await store.fail(job.id, job.leaseToken, { code: 'BACKUP_WORKER_STOPPING' });
        break;
      }
      active = new AbortController();
      let progress = { stage: 'starting', bytes: 0, uploadedBytes: 0 };
      let userCancelled = false; let leaseLost = false;
      const heartbeatStop = new AbortController();
      const timeout = setTimeout(() => active?.abort(Object.assign(new Error('Backup attempt timed out.'), { code: 'BACKUP_TIMEOUT' })), config.timeoutMs);
      const resourceStop = new AbortController();
      const resourceMonitor = (async () => {
        if (!config.shared) return;
        while (!resourceStop.signal.aborted && !active.signal.aborted) {
          if (backupBudgetRequiresAbort(await memory())) {
            active.abort(Object.assign(new Error('Backup stopped to protect shared server memory.'), { code: 'BACKUP_RESOURCE_PRESSURE' })); break;
          }
          await delay(250, null, { signal: resourceStop.signal }).catch(() => {});
        }
      })();
      const heartbeat = (async () => {
        while (!heartbeatStop.signal.aborted) {
          try {
            const current = await store.heartbeat(job.id, job.leaseToken, progress);
            if (current.cancelRequested) { userCancelled = true; active.abort(Object.assign(new Error('Backup cancelled.'), { code: 'BACKUP_CANCELLED' })); }
          } catch (error) { leaseLost = true; active.abort(error); break; }
          await delay(Math.max(250, Math.min(5000, config.leaseSeconds * 1000 / 3)), null, { signal: heartbeatStop.signal }).catch(() => {});
        }
      })();
      try {
        const execute = job.kind === 'restore-test' ? restore : backup;
        const result = await execute({ job, config, storage, metadata: pool, signal: active.signal,
          progress: update => { progress = { ...progress, ...update }; } });
        if (active.signal.aborted) throw active.signal.reason;
        heartbeatStop.abort(); await heartbeat;
        // Explicit last heartbeat fences completion and checks cancellation.
        const finalLease = await store.heartbeat(job.id, job.leaseToken, progress);
        if (finalLease.cancelRequested) { userCancelled = true; throw Object.assign(new Error('Backup cancelled.'), { code: 'BACKUP_CANCELLED' }); }
        await store.complete(job.id, job.leaseToken, { ...result, metadata: {
          dbVersion: result.dbVersion, toolVersion: result.toolVersion, fileCount: result.fileCount,
          manifestChecksum: result.manifestChecksum,
        } });
        log({ event: 'backup-completed', jobId: job.id, attempt: job.attempt, bytes: result.bytes, rss: process.memoryUsage().rss });
        // Never remove a valid backup until a replacement is verified and committed.
        if (job.kind === 'backup') {
          try {
            for (const expired of await store.expired()) {
              try {
                const deletion = await store.claimDeletion(expired.id);
                await storage.removePrefix(deletion.artifactPrefix, { signal });
                await store.markDeleted(deletion.id);
              } catch (error) { log({ event: 'backup-retention-failed', jobId: expired.id, code: safeCode(error) }); }
            }
          } catch (error) { log({ event: 'backup-retention-failed', jobId: job.id, code: safeCode(error) }); }
        }
      } catch (error) {
        const failure = active.signal.reason?.code === 'BACKUP_RESOURCE_PRESSURE' ? active.signal.reason : error;
        if (failure.code === 'BACKUP_RESOURCE_PRESSURE') stopped = true;
        // With a lost lease, recovery owns metadata/cleanup. Never touch a new attempt.
        if (!leaseLost) {
          try { await store.fail(job.id, job.leaseToken, failure, { cancelled: userCancelled, retryable: job.kind !== 'restore-test' }); }
          catch (failure) { log({ event: 'backup-failure-transition-failed', jobId: job.id, code: safeCode(failure) }); }
        }
        log({ event: 'backup-attempt-failed', jobId: job.id, attempt: job.attempt, stage: progress.stage, code: safeCode(failure), rss: process.memoryUsage().rss });
      } finally {
        clearTimeout(timeout); heartbeatStop.abort(); resourceStop.abort(); await heartbeat; await resourceMonitor;
        active = null;
      }
    } while (!once && !stopped);
  } finally {
    signal?.removeEventListener('abort', stop);
    pool.removeListener('error', lost);
    if (lock) {
      lock.removeListener('error', lost);
      await lock.query('SELECT pg_advisory_unlock($1,$2)', LOCK).catch(() => {});
      lock.release(true);
    }
    if (ownedPool) await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  try {
    const config = getNativeBackupConfig();
    await nativeVersion(config.pgDumpPath, undefined, shutdown.signal);
    await nativeVersion(config.pgRestorePath, undefined, shutdown.signal);
    await runBackupWorker({ config, signal: shutdown.signal });
  }
  catch (error) { console.error(JSON.stringify({ event: 'backup-worker-stopped', code: safeCode(error) })); process.exitCode = 1; }
}
