import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getNativeBackupConfig } from '../src/services/nativeBackupConfig.js';
import { executeNativeBackup, executeRestoreVerification } from '../src/services/nativeBackupEngine.js';
import { recoverNativeFiles } from '../src/services/nativeBackupRecovery.js';
import { fixtureStorage, isolatedTestUrl } from './helpers/nativeBackupFixture.mjs';

const url = process.env.BACKUP_NATIVE_TEST_DATABASE_URL;
test('native PostgreSQL backup and isolated restore preserve schema, data and managed file bytes', { skip: !url }, async t => {
  isolatedTestUrl(url);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accounts-native-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = new pg.Client({ connectionString: url }); await client.connect();
  const token = randomUUID().replaceAll('-', '');
  const targetName = `backup_verify_${token}`;
  const role = `backup_verify_${token.slice(0, 16)}`;
  await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  await client.query(`CREATE DATABASE ${targetName} OWNER ${role} TEMPLATE template0`);
  t.after(async () => {
    await client.query(`DROP DATABASE IF EXISTS ${targetName} WITH (FORCE)`);
    await client.query(`DROP ROLE IF EXISTS ${role}`); await client.end();
  });
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS backup_control CASCADE; CREATE SCHEMA backup_control');
  await client.query(`CREATE TABLE backup_control.files(job_id uuid,attempt integer,file_id text,metadata jsonb,PRIMARY KEY(job_id,attempt,file_id));
    CREATE TYPE account_state AS ENUM ('active','closed');
    CREATE TABLE accounts(id BIGSERIAL PRIMARY KEY, amount NUMERIC(40,12), precise BIGINT, state account_state NOT NULL DEFAULT 'active');
    CREATE TABLE payments(id BIGSERIAL PRIMARY KEY,account_id bigint NOT NULL REFERENCES accounts(id),amount numeric(40,12));
    CREATE TABLE ledger(id BIGSERIAL PRIMARY KEY,payment_id bigint UNIQUE NOT NULL REFERENCES payments(id),amount numeric(40,12));
    CREATE FUNCTION mirror_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ledger(payment_id,amount) VALUES(NEW.id,NEW.amount); RETURN NEW; END $$;
    CREATE TRIGGER mirror_payment AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION mirror_payment();
    CREATE INDEX account_amount_idx ON accounts(amount);
    CREATE VIEW account_totals AS SELECT sum(amount) AS total FROM accounts;
    CREATE TABLE documents(id INTEGER PRIMARY KEY,file_path TEXT NOT NULL);
    INSERT INTO accounts(amount,precise) VALUES(9999999999999999999.123456789012,9007199254740993);
    INSERT INTO payments(account_id,amount) VALUES(1,123.000000000001);
    INSERT INTO documents VALUES(1,'local::invoice.pdf');`);
  await fs.mkdir(path.join(root, 'uploads', 'kyc_documents'), { recursive: true });
  const attachment = Buffer.from('Original invoice हिंदी ₹ — native backup integration fixture.');
  await fs.writeFile(path.join(root, 'uploads', 'kyc_documents', 'invoice.pdf'), attachment);
  const target = new URL(url); target.pathname = `/${targetName}`; target.username = role; target.password = '';
  const config = getNativeBackupConfig({ BACKUP_DATABASE_URL: url, BACKUP_ENABLED: 'true', BACKUP_S3_BUCKET: 'test',
    BACKUP_FILES_POLICY: 'immutable-retained', BACKUP_LOCAL_ROOT: root, BACKUP_RESTORE_DATABASE_URL: target.href,
    BACKUP_PG_DUMP: process.env.BACKUP_PG_DUMP || 'pg_dump', BACKUP_PG_RESTORE: process.env.BACKUP_PG_RESTORE || 'pg_restore' });
  const storage = fixtureStorage(path.join(root, 'objects'));
  const id = randomUUID(); const job = { id, attempt: 1, kind: 'backup', scope: 'database-files', artifactPrefix: `native-backups/${id}/attempt-1-${randomUUID()}/` };
  const stages = [];
  const backupStart = performance.now();
  const result = await executeNativeBackup({ job, config, storage, metadata: client, signal: AbortSignal.timeout(30000), progress: value => stages.push(value.stage) });
  const backupDurationMs = performance.now() - backupStart;
  const manifestBytes = await fs.readFile(storage.filename(result.manifestKey));
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), result.manifestChecksum);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.database.checksum, result.checksum);
  assert.equal(manifest.files.count, 1);
  const fileIndexBytes = await fs.readFile(storage.filename(manifest.files.manifestKey));
  assert.equal(createHash('sha256').update(fileIndexBytes).digest('hex'), manifest.files.manifestChecksum);
  const fileIndex = fileIndexBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(fileIndex.length, 1);
  assert.equal(createHash('sha256').update(attachment).digest('hex'), fileIndex[0].checksum);
  assert.equal(result.verificationStatus, 'verified'); assert.equal(result.fileCount, 1);
  assert.ok(stages.includes('dumping')); assert.ok(stages.includes('attachments')); assert.ok(stages.includes('verifying'));
  const { rows: files } = await client.query('SELECT metadata FROM backup_control.files');
  assert.equal(files.length, 1);
  assert.deepEqual(await fs.readFile(storage.filename(files[0].metadata.artifactKey)), attachment);
  const source = { ...job, ...result, status: 'completed', metadata: { manifestChecksum: result.manifestChecksum } };
  const recoveredDirectory = path.join(root, 'recovered');
  assert.deepEqual(await recoverNativeFiles({ job: source, storage, directory: recoveredDirectory }), { count: 1, bytes: attachment.length });
  assert.deepEqual(await fs.readFile(path.join(recoveredDirectory, 'local', files[0].metadata.key)), attachment);
  assert.equal(JSON.parse(await fs.readFile(path.join(recoveredDirectory, 'RECOVERY_VERIFIED.json'), 'utf8')).count, 1);
  await assert.rejects(fs.stat(path.join(recoveredDirectory, 'RECOVERY_INCOMPLETE')), { code: 'ENOENT' });
  await assert.rejects(recoverNativeFiles({ job: source, storage, directory: recoveredDirectory }), { code: 'EEXIST' });
  const restoreStart = performance.now();
  const restored = await executeRestoreVerification({ job: { sourceJob: source }, config, storage, signal: AbortSignal.timeout(30000) });
  const restoreDurationMs = performance.now() - restoreStart;
  assert.equal(restored.verificationStatus, 'restored');
  const verify = new pg.Client({ connectionString: target.href }); await verify.connect();
  try {
    assert.deepEqual((await verify.query('SELECT amount::text,precise::text,state FROM accounts')).rows,
      [{ amount: '9999999999999999999.123456789012', precise: '9007199254740993', state: 'active' }]);
    assert.equal((await verify.query('SELECT count(*)::int AS count FROM ledger')).rows[0].count, 1);
    assert.equal((await verify.query("SELECT count(*)::int AS count FROM pg_indexes WHERE indexname='account_amount_idx'")).rows[0].count, 1);
    assert.equal((await verify.query("SELECT to_regclass('backup_control.files') AS name")).rows[0].name, null);
    assert.equal((await verify.query('SELECT total::text FROM account_totals')).rows[0].total, '9999999999999999999.123456789012');
    assert.equal((await verify.query('INSERT INTO payments(account_id,amount) VALUES(1,5) RETURNING id')).rows[0].id, '2');
    assert.equal((await verify.query('SELECT count(*)::int AS count FROM ledger')).rows[0].count, 2);
    await assert.rejects(verify.query('INSERT INTO payments(account_id,amount) VALUES(999,5)'), /foreign key/);
  } finally { await verify.end(); }
  await assert.rejects(executeRestoreVerification({ job: { sourceJob: source }, config, storage }), /must be empty/);
  await assert.rejects(executeRestoreVerification({ job: { sourceJob: source }, config: { ...config, restoreDatabaseUrl: url }, storage }), /separate local backup_verify/);
  await client.query("CREATE TABLE compressed_oversized_row(body TEXT); INSERT INTO compressed_oversized_row VALUES(repeat('a',2*1024*1024))");
  const oversizedId = randomUUID();
  await assert.rejects(executeNativeBackup({ job: { ...job, id: oversizedId, artifactPrefix: `native-backups/${oversizedId}/attempt-1-${randomUUID()}/` }, config, storage, metadata: client }), /exceeds 1 MiB/);
  await client.query('DROP TABLE compressed_oversized_row');
  const original = await fs.readFile(storage.filename(result.artifactKey));
  await fs.writeFile(storage.filename(result.artifactKey), Buffer.concat([original, Buffer.from('tampered')]));
  await assert.rejects(storage.verify(result.artifactKey, result), /checksum verification/);
  await client.query(`DROP DATABASE ${targetName} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${targetName} OWNER ${role} TEMPLATE template0`);
  await assert.rejects(executeRestoreVerification({ job: { sourceJob: source }, config, storage }), /checksum verification/);
  await fs.mkdir(new URL('../benchmarks/', import.meta.url), { recursive: true });
  await fs.writeFile(new URL('../benchmarks/backup-restore.json', import.meta.url), JSON.stringify({
    recorded_at: new Date().toISOString(), scope: 'Disposable local PostgreSQL 18.4 fixture; actual native pg_dump and pg_restore, filesystem streaming storage adapter, unprivileged fresh verification database.',
    backup_duration_ms: +backupDurationMs.toFixed(2), restore_duration_ms: +restoreDurationMs.toFixed(2), archive_bytes: result.bytes, files: result.fileCount,
    verified: ['archive readback SHA-256','manifest SHA-256','file index SHA-256','attachment bytes SHA-256','file recovery into a fresh private staging directory','numeric precision','enum','foreign key','trigger/function','sequence','index','view','control-schema exclusion'],
    rejected: ['production-style restore target','nonempty restore target','tampered archive before restore','compressed row above expanded size bound'],
    limitations: ['Does not measure production recovery time','Does not exercise S3 network or AWS IAM','File recovery to private staging verified; automatic production publication is intentionally excluded']
  }, null, 2) + '\n');
});
