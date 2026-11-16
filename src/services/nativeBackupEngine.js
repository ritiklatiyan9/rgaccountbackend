import pg from 'pg';
import { Readable } from 'node:stream';
import { devNull } from 'node:os';
import { nativePostgresEnvironment, validateRestoreTarget } from './nativeBackupConfig.js';
import { runNative, nativeVersion } from './nativeBackupProcess.js';
import { captureNativeAttachments } from './nativeBackupFiles.js';

async function verifyArchive(storage, config, key, expected, signal) {
  const operation = runNative(config.pgRestorePath, ['--exit-on-error', `--file=${devNull}`], { input: true, output: false, signal });
  try {
    await storage.verify(key, expected, { signal, consumer: operation.child.stdin });
    await operation.done;
  } catch (error) { operation.stop(); await operation.done.catch(() => {}); throw error; }
}

export async function executeNativeBackup({ job, config, storage, metadata, signal, progress = () => {}, createClient = options => new pg.Client(options) }) {
  const client = createClient(config.database);
  let transaction = false;
  let connected = false;
  const cancelConnection = () => { void client.end().catch(() => {}); };
  signal?.addEventListener('abort', cancelConnection, { once: true });
  try {
    progress({ stage: 'preflight' });
    const env = nativePostgresEnvironment(config.database);
    const dumpVersion = await nativeVersion(config.pgDumpPath, env, signal);
    const restoreVersion = await nativeVersion(config.pgRestorePath, env, signal);
    if (restoreVersion.major < dumpVersion.major) throw new Error('pg_restore must be at least the pg_dump major version.');
    await client.connect(); connected = true;
    const { rows: [server] } = await client.query("SELECT current_setting('server_version_num') AS version");
    if (dumpVersion.major < Math.floor(Number(server.version) / 10000)) throw new Error('pg_dump is older than the source PostgreSQL server.');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { rows: [snapshot] } = await client.query('SELECT pg_export_snapshot() AS id, clock_timestamp() AS captured_at');
    if (!/^[A-Fa-f0-9-]+$/.test(snapshot.id)) throw new Error('Unexpected PostgreSQL snapshot identifier.');
    const artifactKey = `${job.artifactPrefix}database.dump`;
    progress({ stage: 'dumping', bytes: 0, uploadedBytes: 0 });
    const dump = runNative(config.pgDumpPath, ['--format=custom', `--compress=${config.compression}`, '--no-password',
      '--lock-wait-timeout=5000', '--exclude-schema=backup_control', `--snapshot=${snapshot.id}`], { env, signal });
    let archive;
    try {
      archive = await storage.upload(artifactKey, dump.child.stdout, { signal, onProgress: bytes => progress({ stage: 'dumping', bytes, uploadedBytes: bytes }) });
      await dump.done;
    } catch (error) { dump.stop(); await dump.done.catch(() => {}); throw error; }
    let files = null;
    if (job.scope === 'database-files' || job.kind === 'database-files') {
      if (!config.filesEnabled) throw new Error('File backups require the configured immutable-retained storage policy.');
      files = await captureNativeAttachments({ snapshot: client, metadata, job, config, storage, signal, progress });
    }
    await client.query('COMMIT'); transaction = false;
    progress({ stage: 'verifying', bytes: archive.bytes, uploadedBytes: archive.bytes });
    await verifyArchive(storage, config, artifactKey, archive, signal);
    const manifest = {
      format: 'rgaccounts-native-backup', version: 1, jobId: job.id, attempt: job.attempt,
      snapshotAt: snapshot.captured_at, databaseVersion: server.version, dumpVersion: dumpVersion.version,
      scope: files ? 'database-files' : 'database', database: { key: artifactKey, ...archive }, files,
      exclusions: ['backup_control schema', 'cluster roles and tablespaces', 'server secrets', 'external URL file contents'],
      filePolicy: files ? 'Immutable keys retained until capture. Referenced managed originals copied and verified.' : 'Database records and file references only; original file storage must be recovered separately.',
    };
    const manifestKey = `${job.artifactPrefix}manifest.json`;
    const manifestResult = await storage.upload(manifestKey, Readable.from([JSON.stringify(manifest)]), { signal, contentType: 'application/json' });
    await storage.verify(manifestKey, manifestResult, { signal });
    return { artifactKey, manifestKey, ...archive, dbVersion: server.version, toolVersion: dumpVersion.version,
      verificationStatus: 'verified', fileCount: files?.count || 0, manifestChecksum: manifestResult.checksum };
  } finally {
    signal?.removeEventListener('abort', cancelConnection);
    if (transaction && connected) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
}

export async function executeRestoreVerification({ job, config, storage, signal, progress = () => {}, createClient = options => new pg.Client(options) }) {
  const source = job.sourceJob;
  if (!source || source.status !== 'completed' || !['verified', 'restored'].includes(source.verificationStatus)) throw new Error('A completed verified source backup is required.');
  const target = validateRestoreTarget(config);
  const client = createClient(target);
  try {
    await client.connect();
    const { rows: [role] } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    if (role?.rolsuper) throw new Error('Restore verification requires an unprivileged database owner, not a superuser.');
    const { rows: [objects] } = await client.query(`SELECT (
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%') +
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema'))
    )::int AS count`);
    if (objects.count !== 0) throw new Error('Restore verification target must be empty. Provision a fresh isolated database.');
  } finally { await client.end().catch(() => {}); }
  progress({ stage: 'verifying' });
  await verifyArchive(storage, config, source.artifactKey, source, signal);
  progress({ stage: 'restoring' });
  const restore = runNative(config.pgRestorePath, ['--dbname', connectionDatabase(target), '--no-password', '--exit-on-error',
    '--single-transaction', '--no-owner', '--no-privileges'], { env: nativePostgresEnvironment(target), signal, input: true, output: false });
  try {
    await storage.verify(source.artifactKey, source, { signal, consumer: restore.child.stdin });
    await restore.done;
  } catch (error) { restore.stop(); await restore.done.catch(() => {}); throw error; }
  return { verificationStatus: 'restored', bytes: source.bytes, checksum: source.checksum };
}

function connectionDatabase(target) {
  // Database name only is safe in argv; credentials are exclusively in the environment.
  return new pg.Client(target).connectionParameters.database;
}
