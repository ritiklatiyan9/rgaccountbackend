import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql } from '../src/migrations/249_native_backups.js';
import { createNativeBackupJobs, publicNativeBackupJob } from '../src/services/nativeBackupJobs.js';

async function fixture(t, options = {}) {
  const engine = new PGlite();
  t.after(() => engine.close());
  await engine.exec(migrationSql);
  const query = async (sql, values) => {
    const result = await engine.query(sql, values);
    return { ...result, rowCount: result.affectedRows };
  };
  const db = { query, connect: async () => ({ query, release() {} }) };
  return { engine, db, query, jobs: createNativeBackupJobs(db, { retentionDays: 30, maxAttempts: 2, leaseSeconds: 120, prefix: 'test-backups', restoreEnabled: true, ...options }) };
}
const verified = job => ({ bytes: 256, uploadedBytes: 256, checksum: 'a'.repeat(64), verificationStatus: 'verified',
  artifactKey: `${job.artifactPrefix}database.dump`, manifestKey: `${job.artifactPrefix}manifest.json`, metadata: { fileCount: 0 } });
async function completeBackup(jobs) {
  const queued = await jobs.enqueue(1, { scope: 'database' });
  const active = await jobs.claim('test-worker');
  const completed = await jobs.complete(queued.id, active.leaseToken, verified(active));
  return { queued, active, completed };
}

test('durable backup start commits metadata/audit, rejects duplicate activity and reloads from another store', async t => {
  const { db, query, jobs } = await fixture(t);
  const created = await jobs.enqueue(73, { scope: 'database' });
  assert.equal(created.status, 'queued');
  assert.equal(created.attempt, 0);
  assert.equal(created.ownerId, '73');
  assert.equal((await query('SELECT action FROM backup_control.events')).rows[0].action, 'created');
  await assert.rejects(jobs.enqueue(8), error => error.statusCode === 409 && error.code === 'BACKUP_ACTIVE');
  const restarted = createNativeBackupJobs(db);
  assert.equal((await restarted.get(created.id)).status, 'queued');
  assert.equal((await restarted.list()).length, 1);
  await assert.rejects(jobs.get('not-a-uuid'), /valid backup job/);
  await assert.rejects(jobs.enqueue(1, { scope: 'custom-sql' }), /supported backup scope/);
});

test('audit failure rolls back the requested backup instead of releasing an unaudited job', async t => {
  const { db, query } = await fixture(t);
  const broken = { query, connect: async () => {
    const connection = await db.connect();
    return { ...connection, query: (sql, args) => sql.startsWith('INSERT INTO backup_control.events')
      ? Promise.reject(Object.assign(new Error('audit denied'), { code: '42501' })) : connection.query(sql, args) };
  } };
  await assert.rejects(createNativeBackupJobs(broken).enqueue(1), /audit denied/);
  assert.equal((await query('SELECT count(*) FROM backup_control.jobs')).rows[0].count, 0);
});

test('claim and publication are fenced, verified artifacts are mandatory and public metadata excludes storage keys', async t => {
  const { jobs, query } = await fixture(t);
  await jobs.enqueue(1);
  const active = await jobs.claim('worker-a');
  assert.equal(active.attempt, 1);
  assert.equal(await jobs.claim('worker-b'), null);
  assert.ok(active.artifactPrefix.includes(active.leaseToken));
  await assert.rejects(jobs.heartbeat(active.id, 'wrong-token', { stage: 'dumping' }), error => error.code === 'BACKUP_LEASE_LOST');
  const progress = await jobs.heartbeat(active.id, active.leaseToken, { stage: 'uploading', bytes: 1024, uploadedBytes: 512 });
  assert.equal(progress.uploadedBytes, 512);
  await assert.rejects(jobs.complete(active.id, active.leaseToken, { ...verified(active), verificationStatus: 'pending' }), /cannot complete/);
  await assert.rejects(jobs.complete(active.id, active.leaseToken, { ...verified(active), artifactKey: 'another-job/data' }), /cannot complete/);
  const finished = await jobs.complete(active.id, active.leaseToken, verified(active));
  assert.equal(finished.status, 'completed');
  assert.equal(finished.verificationStatus, 'verified');
  assert.ok(Date.parse(finished.expiresAt) > Date.now());
  assert.equal((await query('SELECT status FROM backup_control.attempts')).rows[0].status, 'completed');
  const publicJob = publicNativeBackupJob(finished);
  for (const secret of ['leaseToken','artifactKey','manifestKey','artifactPrefix','ownerId','metadata']) assert.equal(secret in publicJob, false);
  await assert.rejects(jobs.complete(active.id, active.leaseToken, verified(active)), error => error.code === 'BACKUP_LEASE_LOST');
});

test('running cancellation keeps the global slot until the worker aborts and retry uses a fresh artifact prefix', async t => {
  const { jobs } = await fixture(t);
  await jobs.enqueue(1);
  const first = await jobs.claim('worker');
  const cancel = await jobs.cancel(first.id, 1);
  assert.equal(cancel.status, 'running');
  assert.equal(cancel.cancelRequested, true);
  await assert.rejects(jobs.enqueue(2), error => error.code === 'BACKUP_ACTIVE');
  assert.equal((await jobs.heartbeat(first.id, first.leaseToken)).cancelRequested, true);
  await assert.rejects(jobs.complete(first.id, first.leaseToken, verified(first)), error => error.code === 'BACKUP_CANCELLED');
  assert.equal((await jobs.fail(first.id, first.leaseToken, new Error('aborted'))).status, 'cancelled');
  await jobs.retry(first.id, 1);
  const second = await jobs.claim('worker');
  assert.equal(second.attempt, 2);
  assert.notEqual(second.artifactPrefix, first.artifactPrefix);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.cancelRequested, false);
});

test('queued cancellation releases the slot without starting a process', async t => {
  const { jobs } = await fixture(t);
  const queued = await jobs.enqueue(1);
  const cancelled = await jobs.cancel(queued.id, 1);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.completedAt);
  assert.equal(await jobs.claim('worker'), null);
  await jobs.enqueue(2);
});

test('failures retry with backoff up to the attempt limit without persisting secret error strings', async t => {
  const { jobs, query } = await fixture(t);
  await jobs.enqueue(1);
  const first = await jobs.claim('worker');
  const retry = await jobs.fail(first.id, first.leaseToken, Object.assign(new Error('password=secret customer-name'), { code: 'ETIMEDOUT' }));
  assert.equal(retry.status, 'queued');
  assert.ok(Date.parse(retry.availableAt) > Date.now());
  assert.match(retry.error, /ETIMEDOUT/);
  assert.doesNotMatch(retry.error, /secret|customer-name/);
  assert.equal(await jobs.claim('worker'), null);
  await query("UPDATE backup_control.jobs SET available_at=now()-interval '1 second' WHERE id=$1", [first.id]);
  const second = await jobs.claim('worker');
  assert.equal(second.attempt, 2);
  assert.equal((await jobs.fail(second.id, second.leaseToken, new Error('network'))).status, 'failed');
  assert.equal((await query('SELECT count(*) FROM backup_control.attempts')).rows[0].count, 2);
});

test('expired heartbeats cannot publish, recover durably, and old attempts cannot mutate the replacement', async t => {
  const { jobs, query } = await fixture(t);
  await jobs.enqueue(1);
  const first = await jobs.claim('crashed-worker');
  await query("UPDATE backup_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
  await assert.rejects(jobs.heartbeat(first.id, first.leaseToken), error => error.code === 'BACKUP_LEASE_LOST');
  await assert.rejects(jobs.complete(first.id, first.leaseToken, verified(first)), error => error.code === 'BACKUP_LEASE_LOST');
  const recovered = await jobs.recover();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, 'queued');
  await query("UPDATE backup_control.jobs SET available_at=now()-interval '1 second' WHERE id=$1", [first.id]);
  const replacement = await jobs.claim('replacement');
  await assert.rejects(jobs.fail(first.id, first.leaseToken, new Error('late callback')), error => error.code === 'BACKUP_LEASE_LOST');
  assert.notEqual(replacement.leaseToken, first.leaseToken);
  assert.equal((await jobs.get(first.id)).status, 'running');
});

test('isolated restoration requires a completed retained verified source and records its own audit', async t => {
  const { jobs, db, query } = await fixture(t);
  const { completed } = await completeBackup(jobs);
  await assert.rejects(createNativeBackupJobs(db).enqueue(1, { kind: 'restore-test', sourceJobId: completed.id }), /isolated restore target/);
  const request = await jobs.enqueue(1, { kind: 'restore-test', sourceJobId: completed.id });
  const active = await jobs.claim('restore-worker');
  assert.equal(active.sourceJob.id, completed.id);
  assert.equal(active.sourceJob.artifactKey, completed.artifactKey);
  await assert.rejects(jobs.complete(request.id, active.leaseToken, { verificationStatus: 'verified' }), /Restoration must complete/);
  assert.equal((await jobs.complete(request.id, active.leaseToken, { verificationStatus: 'restored', metadata: { restoredTables: 5 } })).status, 'completed');
  assert.equal((await query("SELECT count(*) FROM backup_control.events WHERE action='restore-test-completed'")).rows[0].count, 1);
  assert.ok(publicNativeBackupJob(await jobs.get(completed.id)).restoreVerifiedAt);
  await query("UPDATE backup_control.jobs SET expires_at=now()-interval '1 day' WHERE id=$1", [completed.id]);
  const retained = await jobs.enqueue(1, { kind: 'restore-test', sourceJobId: completed.id });
  assert.equal(retained.status,'queued','retention eligibility must not make the last protected backup unusable');
});

test('retention preserves the newest verified backup and fences restoration before deleting expired artifacts', async t => {
  const { jobs, query } = await fixture(t);
  const first = await completeBackup(jobs);
  await query("UPDATE backup_control.jobs SET expires_at=now()-interval '1 day',completed_at=now()-interval '2 day' WHERE id=$1", [first.completed.id]);
  assert.deepEqual(await jobs.expired(), []);
  await assert.rejects(jobs.claimDeletion(first.completed.id), /newest verified/);
  const second = await completeBackup(jobs);
  await query("UPDATE backup_control.jobs SET expires_at=now()-interval '1 day' WHERE id=$1", [second.completed.id]);
  const candidates = await jobs.expired();
  assert.deepEqual(candidates.map(row => row.id), [first.completed.id]);
  assert.equal((await jobs.claimDeletion(first.completed.id)).status, 'deleting');
  await assert.rejects(jobs.enqueue(1, { kind: 'restore-test', sourceJobId: first.completed.id }), /available, verified/);
  assert.equal((await jobs.expired())[0].status, 'deleting', 'partial S3 cleanup can be retried');
  assert.equal((await jobs.markDeleted(first.completed.id)).status, 'expired');
  assert.deepEqual(await jobs.expired(), []);
  assert.equal((await query("SELECT count(*) FROM backup_control.events WHERE action='retention-deleted'")).rows[0].count, 1);
});

test('database-only replacement never authorizes deletion of the last backup containing files', async t => {
  const { jobs,query } = await fixture(t);
  const first = await jobs.enqueue(1,{scope:'database-files'});
  const active = await jobs.claim('files-worker');
  await jobs.complete(first.id,active.leaseToken,verified(active));
  await query("UPDATE backup_control.jobs SET expires_at=now()-interval '1 day',completed_at=now()-interval '2 days' WHERE id=$1",[first.id]);
  await completeBackup(jobs);
  assert.deepEqual(await jobs.expired(),[]);
  await assert.rejects(jobs.claimDeletion(first.id),/covering this scope/);
  await jobs.enqueue(1,{scope:'database-files'});
  const replacement = await jobs.claim('files-worker');
  await jobs.complete(replacement.id,replacement.leaseToken,verified(replacement));
  assert.deepEqual((await jobs.expired()).map(item=>item.id),[first.id]);
});

test('pending restoration prevents expiry cleanup even after source retention passes', async t => {
  const { jobs, query } = await fixture(t);
  const first = await completeBackup(jobs);
  await query("UPDATE backup_control.jobs SET completed_at=now()-interval '2 days' WHERE id=$1", [first.completed.id]);
  await completeBackup(jobs);
  const restore = await jobs.enqueue(1, { kind: 'restore-test', sourceJobId: first.completed.id });
  await query("UPDATE backup_control.jobs SET expires_at=now()-interval '1 day' WHERE id=$1", [first.completed.id]);
  assert.deepEqual(await jobs.expired(), []);
  await assert.rejects(jobs.claimDeletion(first.completed.id), /being used/);
  await jobs.cancel(restore.id, 1);
  assert.equal((await jobs.expired()).length, 1);
});

test('real PostgreSQL independent clients serialize simultaneous enqueue/claim using unique index and SKIP LOCKED', { skip: !process.env.BACKUP_NATIVE_TEST_DATABASE_URL }, async t => {
  const target = new URL(process.env.BACKUP_NATIVE_TEST_DATABASE_URL);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname), 'native integration tests require loopback PostgreSQL');
  assert.match(target.pathname, /_test$/);
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: target.href, max: 5 });
  t.after(() => pool.end());
  await pool.query(migrationSql);
  // Explicitly disposable fixture database only; never application storage.
  await pool.query('TRUNCATE backup_control.events,backup_control.files,backup_control.attempts,backup_control.jobs');
  const stores = Array.from({ length: 5 }, () => createNativeBackupJobs(pool));
  const starts = await Promise.allSettled(stores.map(store => store.enqueue(1)));
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(starts.filter(result => result.status === 'rejected' && result.reason.code === 'BACKUP_ACTIVE').length, 4);
  const claims = await Promise.all(stores.map((store, index) => store.claim(`worker-${index}`)));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await pool.query('SELECT count(*) FROM backup_control.attempts')).rows[0].count, '1');
});
