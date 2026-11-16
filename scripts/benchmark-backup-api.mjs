// Isolated HTTP timing, never a production benchmark or authentication benchmark.
// BACKUP_API_TEST_DATABASE_URL=postgresql://user@127.0.0.1:55439/backup_engine_test \
// BACKUP_PG_DUMP=/path/to/pg_dump BACKUP_PG_RESTORE=/path/to/pg_restore \
// node scripts/benchmark-backup-api.mjs
// A fresh random *_test database is created and removed; the supplied DB is only
// the local admin connection. No application .env is read and no S3 calls run.
import assert from 'node:assert/strict';
import pg from 'pg';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { migrationSql } from '../src/migrations/249_native_backups.js';
import { fixtureStorage, isolatedTestUrl } from '../test/helpers/nativeBackupFixture.mjs';
import { getNativeBackupConfig } from '../src/services/nativeBackupConfig.js';

const url = isolatedTestUrl(process.env.BACKUP_API_TEST_DATABASE_URL);
process.env.DOTENV_CONFIG_PATH = '/dev/null';
const configFor = databaseUrl => getNativeBackupConfig({
  BACKUP_ENABLED: 'true', BACKUP_DATABASE_URL: databaseUrl, BACKUP_S3_BUCKET: 'synthetic-local-fixture',
  BACKUP_PG_DUMP: process.env.BACKUP_PG_DUMP || 'pg_dump',
  BACKUP_PG_RESTORE: process.env.BACKUP_PG_RESTORE || 'pg_restore', BACKUP_COMPRESSION: '1',
});
const round = value => Number(value.toFixed(3));
const distribution = values => {
  assert.ok(values.length, 'A measured operation needs at least one sample.');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return { samples: values.length, median_ms: round(percentile(.5)), p95_ms: round(percentile(.95)),
    p99_ms: round(percentile(.99)), max_ms: round(sorted.at(-1)), raw_ms: values.map(round) };
};

if (process.argv.includes('--worker')) {
  // The same independently managed worker code and real pg_dump/pg_restore are
  // used. Only the private object store is replaced by a streaming disk fixture.
  const { runBackupWorker } = await import('../src/workers/backupWorker.js');
  const { executeNativeBackup } = await import('../src/services/nativeBackupEngine.js');
  const root = process.env.BACKUP_API_BENCH_STORAGE;
  if (!root?.startsWith(path.join(os.tmpdir(), 'backup-api-benchmark-'))) throw new Error('Worker storage must be its private benchmark temporary directory.');
  let lastStage;
  await runBackupWorker({ config: configFor(url.href), storage: fixtureStorage(root), once: true,
    signal: AbortSignal.timeout(120000),
    log: value => process.send?.({ event: value.event }),
    backup: input => executeNativeBackup({ ...input, progress: update => {
      input.progress(update);
      if (lastStage !== update.stage) { lastStage = update.stage; process.send?.({ stage: update.stage }); }
    } }),
  });
} else {
  const samples = Number(process.env.BACKUP_API_BENCH_SAMPLES || 20);
  const fixtureMiB = Number(process.env.BACKUP_API_BENCH_FIXTURE_MIB || 64);
  assert.ok(Number.isInteger(samples) && samples >= 10 && samples <= 100, 'Use 10–100 measured samples.');
  assert.ok(Number.isInteger(fixtureMiB) && fixtureMiB >= 16 && fixtureMiB <= 256, 'Use a 16–256 MiB synthetic fixture.');
  const database = `backup_api_${randomUUID().replaceAll('-', '')}_test`;
  const fixtureUrl = new URL(url); fixtureUrl.pathname = `/${database}`;
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-api-benchmark-'));
  let db, server, defaultPool, child, created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database} TEMPLATE template0`); created = true;
    db = new pg.Pool({ connectionString: fixtureUrl.href, max: 3, connectionTimeoutMillis: 10000, application_name: 'backup-http-benchmark' });
    await db.query(migrationSql);
    await db.query(`CREATE TABLE users(id INTEGER PRIMARY KEY, role TEXT NOT NULL, is_active BOOLEAN NOT NULL);
      INSERT INTO users SELECT n,'admin',true FROM generate_series(1,${samples + 5}) n;
      CREATE TABLE benchmark_records(id BIGSERIAL PRIMARY KEY,body TEXT NOT NULL);
      ALTER TABLE benchmark_records ALTER COLUMN body SET STORAGE EXTERNAL;
      INSERT INTO benchmark_records(body) SELECT repeat(md5(n::text),128) FROM generate_series(1,${fixtureMiB * 256}) n;
      ANALYZE benchmark_records;`);
    const settings = (await db.query(`SELECT current_setting('server_version') AS postgres,
      current_setting('fsync') AS fsync,current_setting('shared_buffers') AS shared_buffers,
      current_setting('max_connections') AS max_connections`)).rows[0];
    // Even the unused application pool is restricted to this disposable DB
    // before importing the real router and its live role-check middleware.
    Object.assign(process.env, { DB_HOST: fixtureUrl.hostname, DB_PORT: fixtureUrl.port || '5432',
      DB_NAME: database, DB_USER: decodeURIComponent(fixtureUrl.username),
      DB_PASSWORD: decodeURIComponent(fixtureUrl.password), DB_SSL: 'false', DB_POOL_MAX: '3' });
    const { createNativeBackupRouter } = await import('../src/routes/nativeBackup.routes.js');
    ({ default: defaultPool } = await import('../src/config/db.js'));
    const app = express(); app.use(express.json());
    app.use('/backups', createNativeBackupRouter({ db, config: configFor(fixtureUrl.href),
      authenticate(req, _res, next) { req.user = { id: Number(req.headers['x-fixture-user']), role: 'admin' }; next(); },
      storage: { presign() { throw new Error('No downloads or external storage calls are permitted in this benchmark.'); } },
    }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}/backups`;
    const request = async (method, route, user, body) => {
      const started = performance.now();
      const response = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'x-fixture-user': String(user) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      return { status: response.status, data, ms: performance.now() - started };
    };
    const enqueue = [], cancel = [], historyIdle = [], historyDuringBackup = [];
    const warmups = 3;
    for (let index = 0; index < samples + warmups; index++) {
      const user = index + 1;
      const start = await request('POST', '/jobs', user, { scope: 'database' });
      assert.equal(start.status, 202); assert.equal(start.data.status, 'queued');
      const stop = await request('POST', `/jobs/${start.data.id}/cancel`, user, {});
      assert.equal(stop.status, 200); assert.equal(stop.data.status, 'cancelled');
      const history = await request('GET', '/jobs', user);
      assert.equal(history.status, 200);
      assert.ok(history.data.jobs.some(job => job.id === start.data.id && job.status === 'cancelled'));
      if (index >= warmups) { enqueue.push(start.ms); cancel.push(stop.ms); historyIdle.push(history.ms); }
    }
    const workerJob = await request('POST', '/jobs', samples + 4, { scope: 'database' });
    assert.equal(workerJob.status, 202);
    child = spawn(process.execPath, ['--max-old-space-size=192', fileURLToPath(import.meta.url), '--worker'], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, DOTENV_CONFIG_PATH: '/dev/null',
        BACKUP_API_TEST_DATABASE_URL: fixtureUrl.href, BACKUP_API_BENCH_STORAGE: root,
        BACKUP_PG_DUMP: process.env.BACKUP_PG_DUMP, BACKUP_PG_RESTORE: process.env.BACKUP_PG_RESTORE },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let finished = false, childError = '', successfulWorker = false;
    child.stderr.on('data', chunk => { childError = (childError + chunk).slice(-4000); });
    const completion = new Promise((resolve, reject) => {
      child.once('error', error => { finished = true; reject(error); });
      child.once('exit', code => { finished = true; code === 0 ? resolve() : reject(new Error(`Isolated worker exited ${code}: ${childError}`)); });
    });
    // Keep early process failures observed while waiting for dump readiness.
    completion.catch(() => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker did not begin dumping within 30 seconds.')), 30000);
      child.on('message', message => {
        if (message.event === 'backup-completed') successfulWorker = true;
        if (message.stage === 'dumping') { clearTimeout(timer); resolve(); }
      });
      completion.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
    const workerWindowStart = performance.now();
    while (!finished) {
      const history = await request('GET', '/jobs', samples + 5);
      assert.equal(history.status, 200);
      historyDuringBackup.push(history.ms);
      await delay(5);
    }
    await completion;
    assert.ok(successfulWorker, 'The real isolated worker must complete its native archive verification.');
    const completed = await request('GET', `/jobs/${workerJob.data.id}`, samples + 5);
    assert.equal(completed.data.status, 'completed'); assert.equal(completed.data.verificationStatus, 'verified');
    const counts = (await db.query(`SELECT (SELECT count(*)::int FROM backup_control.jobs) AS jobs,
      (SELECT count(*)::int FROM backup_control.events WHERE action='created') AS created_events,
      (SELECT count(*)::int FROM backup_control.events WHERE action='cancel-requested') AS cancellation_events`)).rows[0];
    const report = {
      recorded_at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
      scope: 'Real Express native backup router over loopback HTTP, real PostgreSQL durable transitions, audit writes and live role checks. Synthetic identity is injected before the live role guard; JWT/session verification, application middleware, proxies and production network are excluded.',
      database_settings: settings, synthetic_payload_mib: fixtureMiB,
      fixture: '4096-byte per-row repeated MD5 text with PostgreSQL TOAST compression disabled; deliberately synthetic, compressible data.',
      configuration: { api_pool_max: 3, worker_pool_max: 3, backup_concurrency: 1, compression: 1, warmup_rounds: warmups,
        rate_limit: 'Distinct synthetic active administrators used for start/cancel rounds; normal rate limit remains enabled.',
        storage: 'Private local filesystem streaming fixture with archive parsing and checksum readback; no S3 traffic.' },
      enqueue_post_202: distribution(enqueue), cancel_post_200: distribution(cancel),
      history_get_idle: distribution(historyIdle), history_get_during_native_worker: distribution(historyDuringBackup),
      worker_observation_window_ms: round(performance.now() - workerWindowStart),
      worker_result: { status: completed.data.status, verification_status: completed.data.verificationStatus, archive_bytes: completed.data.bytes },
      durable_audit_counts: counts,
      enqueue_target: { target_ms: 500, sample_max_below_target: Math.max(...enqueue) < 500,
        qualification: 'Local development evidence only. Small sample count; p99 is the maximum for 20 samples. Not a production SLA or supported-volume guarantee.' },
      unmeasured: ['JWT and session authentication overhead', 'production middleware and reverse proxy latency', 'production concurrent user load',
        'remote PostgreSQL latency and hosted quotas', 'real S3 upload performance', '5/10 GiB datasets', 'production p95/p99 under backup load'],
    };
    await fs.mkdir(new URL('../benchmarks/', import.meta.url), { recursive: true });
    await fs.writeFile(new URL('../benchmarks/backup-api.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ enqueue_post_202: report.enqueue_post_202, history_get_idle: report.history_get_idle,
      history_get_during_native_worker: report.history_get_during_native_worker, worker_result: report.worker_result, durable_audit_counts: counts }, null, 2));
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await db?.end(); await defaultPool?.end();
    if (created) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end(); await fs.rm(root, { recursive: true, force: true });
  }
}
