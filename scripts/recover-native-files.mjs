import 'dotenv/config';
import pg from 'pg';
import { getNativeBackupConfig } from '../src/services/nativeBackupConfig.js';
import { createNativeBackupJobs } from '../src/services/nativeBackupJobs.js';
import { createNativeBackupStorage } from '../src/services/nativeBackupStorage.js';
import { recoverNativeFiles } from '../src/services/nativeBackupRecovery.js';

const [id, directory] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(id || '') || !directory || process.argv.length !== 4) {
  console.error('Usage: node scripts/recover-native-files.mjs JOB_UUID NEW_PRIVATE_DIRECTORY');
  process.exitCode = 1;
} else {
  const config = getNativeBackupConfig();
  const pool = new pg.Pool({ ...config.database, max: 1, connectionTimeoutMillis: 10000 });
  const jobs = createNativeBackupJobs(pool, config);
  const actor = 'operator:file-recovery';
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort()); process.once('SIGINT', () => shutdown.abort());
  try {
    const job = await jobs.get(id);
    await jobs.audit(id, actor, 'file-recovery-started');
    const result = await recoverNativeFiles({ job, storage: createNativeBackupStorage(config), directory, signal: shutdown.signal });
    await jobs.audit(id, actor, 'file-recovery-completed', result);
    console.log(JSON.stringify({ event: 'file-recovery-completed', ...result }));
  } catch (error) {
    await jobs.audit(id, actor, 'file-recovery-failed').catch(() => {});
    console.error('File recovery failed. The private staging directory, if created, must not be used until recovery is verified.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
