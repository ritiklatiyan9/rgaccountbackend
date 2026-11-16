import pg from 'pg';
import path from 'node:path';

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}.`);
  return number;
}

/** Configuration is deliberately independent of the application's pool and .env loader. */
export function getNativeBackupConfig(env = process.env) {
  const shared = env.BACKUP_WORKER_MODE === 'shared';
  const nativeBin = path.join(process.cwd(), 'node_modules', '.cache', 'dg-postgresql-18.4', 'bin');
  const workerIdentity = env.BACKUP_PROCESS_ROLE === 'worker';
  const accessKeyId = workerIdentity ? env.BACKUP_WORKER_AWS_ACCESS_KEY_ID : env.BACKUP_DOWNLOAD_AWS_ACCESS_KEY_ID;
  const secretAccessKey = workerIdentity ? env.BACKUP_WORKER_AWS_SECRET_ACCESS_KEY : env.BACKUP_DOWNLOAD_AWS_SECRET_ACCESS_KEY;
  const database = env.BACKUP_DATABASE_URL
    ? { connectionString: env.BACKUP_DATABASE_URL }
    : { host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_NAME,
      user: env.DB_USER, password: env.DB_PASSWORD,
      ssl: env.DB_SSL === 'true' || env.DB_HOST?.includes('neon') ? { rejectUnauthorized: true } : false };
  const prefix = (env.BACKUP_S3_PREFIX || 'accounts-native-backups').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,160}$/.test(prefix)) throw new Error('Invalid BACKUP_S3_PREFIX.');
  const config = {
    enabled: env.BACKUP_ENABLED === 'true' && !!env.BACKUP_S3_BUCKET,
    database, bucket: env.BACKUP_S3_BUCKET, region: env.BACKUP_S3_REGION || env.AWS_REGION || 'ap-south-1', prefix,
    kmsKeyId: env.BACKUP_KMS_KEY_ID,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    shared,
    retentionDays: integer(env.BACKUP_RETENTION_DAYS, 30, 1, 3650, 'BACKUP_RETENTION_DAYS'),
    maxAttempts: integer(env.BACKUP_MAX_ATTEMPTS, 3, 1, 5, 'BACKUP_MAX_ATTEMPTS'),
    leaseSeconds: integer(env.BACKUP_LEASE_SECONDS, 90, 30, 600, 'BACKUP_LEASE_SECONDS'),
    timeoutMs: integer(env.BACKUP_TIMEOUT_MS, 6 * 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000, 'BACKUP_TIMEOUT_MS'),
    pollMs: integer(env.BACKUP_POLL_MS, 3000, 100, 60000, 'BACKUP_POLL_MS'),
    compression: integer(env.BACKUP_COMPRESSION, 1, 0, 9, 'BACKUP_COMPRESSION'),
    partSize: integer(env.BACKUP_PART_MIB, shared ? 5 : 8, 5, 64, 'BACKUP_PART_MIB') * 1024 * 1024,
    uploadConcurrency: integer(env.BACKUP_UPLOAD_CONCURRENCY, shared ? 1 : 2, 1, 4, 'BACKUP_UPLOAD_CONCURRENCY'),
    maxArchiveBytes: integer(env.BACKUP_MAX_ARCHIVE_GIB, shared ? 40 : 50, 1, 500, 'BACKUP_MAX_ARCHIVE_GIB') * 1024 ** 3,
    pgDumpPath: env.BACKUP_PG_DUMP || (shared ? path.join(nativeBin, 'pg_dump') : 'pg_dump'),
    pgRestorePath: env.BACKUP_PG_RESTORE || (shared ? path.join(nativeBin, 'pg_restore') : 'pg_restore'),
    filesEnabled: env.BACKUP_FILES_POLICY === 'immutable-retained',
    localRoot: env.BACKUP_LOCAL_ROOT || process.cwd(),
    restoreDatabaseUrl: env.BACKUP_RESTORE_DATABASE_URL,
    restoreTargetLabel: 'Isolated local verification database',
    restoreEnabled: !!env.BACKUP_RESTORE_DATABASE_URL,
  };
  if (config.maxArchiveBytes > config.partSize * 9999) throw new Error('Increase BACKUP_PART_MIB to keep the archive below 10,000 multipart parts.');
  if (config.enabled) {
    const parameters = connectionParameters(database);
    const local = ['localhost', '127.0.0.1', '::1'].includes(parameters.host) || parameters.host?.startsWith('/');
    if (!local && (!parameters.ssl || parameters.ssl.rejectUnauthorized === false)) throw new Error('Remote backup database connections require verified TLS (sslmode=verify-full).');
  }
  return config;
}

export function connectionParameters(database) {
  return new pg.Client(database).connectionParameters;
}

/** Passwords stay out of argv and logs. No shell is involved in native execution. */
export function nativePostgresEnvironment(database, extra = {}) {
  const p = connectionParameters(database);
  return {
    PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
    PGHOST: p.host, PGPORT: String(p.port), PGDATABASE: p.database, PGUSER: p.user,
    PGPASSWORD: p.password || '', PGCONNECT_TIMEOUT: '15',
    PGSSLMODE: p.ssl ? 'verify-full' : 'disable',
    ...(p.ssl ? { PGSSLROOTCERT: process.env.BACKUP_PG_SSL_ROOT_CERT || process.env.PGSSLROOTCERT || 'system' } : {}),
    PGAPPNAME: 'accounts-backup-worker', ...extra,
  };
}

export function validateRestoreTarget(config) {
  if (!config.restoreDatabaseUrl) throw new Error('Isolated restore verification is not configured.');
  const target = connectionParameters({ connectionString: config.restoreDatabaseUrl });
  const source = connectionParameters(config.database);
  if (!['localhost', '127.0.0.1', '::1'].includes(target.host)
      || !/^backup_verify_[a-z0-9_]+$/.test(target.database)
      || target.database === source.database) {
    throw new Error('Restore target must be a separate local backup_verify_* database.');
  }
  return { connectionString: config.restoreDatabaseUrl };
}
