import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startBackupWorkerSupervisor } from '../src/services/backupWorkerSupervisor.js';
import { backupBudgetAllowsStart, backupBudgetRequiresAbort, sharedBackupMemory } from '../src/services/backupResourceBudget.js';
import { getNativeBackupConfig } from '../src/services/nativeBackupConfig.js';

test('shared supervisor limits worker heap/priority and excludes unrelated API secrets', async () => {
  const spawned = []; const scheduled = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.pid = 321;
    child.kill = signal => { child.signal = signal; if (signal === 'SIGTERM') queueMicrotask(() => child.emit('exit', 0)); };
    spawned.push({ command, args, options, child }); return child;
  };
  const supervisor = startBackupWorkerSupervisor({
    env: { BACKUP_ENABLED: 'true', BACKUP_WORKER_MODE: 'shared', BACKUP_DATABASE_URL: 'fixture-db',
      BACKUP_WORKER_AWS_SECRET_ACCESS_KEY: 'worker-only', BACKUP_DOWNLOAD_AWS_SECRET_ACCESS_KEY: 'download-only',
      JWT_ACCESS_SECRET: 'unrelated-auth', SMTP_PASS: 'unrelated-mailer', AWS_SECRET_ACCESS_KEY: 'unrelated-aws', PATH: '/usr/bin' },
    spawnProcess, log() {}, schedule: (callback, ms) => { const handle = { callback, ms, unref() {} }; scheduled.push(handle); return handle; }, unschedule() {},
  });
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes('--max-old-space-size=64'));
  if (process.platform !== 'win32') assert.deepEqual(spawned[0].args.slice(0, 2), ['-n', '15']);
  const env = spawned[0].options.env;
  assert.equal(env.BACKUP_WORKER_AWS_SECRET_ACCESS_KEY, 'worker-only');
  assert.equal(env.BACKUP_UPLOAD_CONCURRENCY, '1');
  assert.equal(env.DOTENV_CONFIG_PATH, '/dev/null');
  for (const key of ['JWT_ACCESS_SECRET', 'SMTP_PASS', 'AWS_SECRET_ACCESS_KEY', 'BACKUP_DOWNLOAD_AWS_SECRET_ACCESS_KEY']) assert.equal(key in env, false);
  spawned[0].child.emit('exit', 137);
  assert.equal(scheduled[0].ms, 15000);
  scheduled[0].callback(); assert.equal(spawned.length, 2);
  await supervisor.stop(); assert.equal(spawned[1].child.signal, 'SIGTERM');
  spawned[1].child.emit('exit', 0);
  assert.equal(scheduled.filter(timer => timer.ms === 15000).length, 1, 'shutdown must not restart the process');
});

test('shared process is opt-in, stays stopped during maintenance, and a missing executable cannot crash the API', async () => {
  for (const env of [{}, { BACKUP_ENABLED: 'true' }, { BACKUP_ENABLED: 'true', BACKUP_WORKER_MODE: 'shared', BACKUP_MAINTENANCE_MODE: 'true' }]) {
    const supervisor = startBackupWorkerSupervisor({ env, spawnProcess: () => assert.fail('unexpected worker') }); await supervisor.stop();
  }
  let timer;
  const child = new EventEmitter();
  const supervisor = startBackupWorkerSupervisor({ env: { BACKUP_ENABLED: 'true', BACKUP_WORKER_MODE: 'shared' }, spawnProcess: () => child,
    schedule: callback => { timer = callback; return { unref() {} }; }, unschedule() {}, log() {} });
  child.emit('error', new Error('binary missing')); assert.equal(typeof timer, 'function');
  await supervisor.stop();
});

test('memory admission and cancellation use the whole service cgroup, including native processes', async () => {
  const MiB = 1024 ** 2;
  const memory = await sharedBackupMemory({ rss: 80 * MiB, readFile: async filename => filename.endsWith('memory.current') ? String(200 * MiB) : String(512 * MiB) });
  assert.equal(backupBudgetAllowsStart(memory), true);
  assert.equal(backupBudgetAllowsStart({ ...memory, usedBytes: 370 * MiB }), false);
  assert.equal(backupBudgetRequiresAbort({ ...memory, usedBytes: 450 * MiB }), true);
  assert.equal(backupBudgetRequiresAbort({ ...memory, rss: 170 * MiB }), true);
  const oldCgroup = await sharedBackupMemory({ rss: 80 * MiB, readFile: async filename => {
    if (!filename.includes('/memory/')) throw new Error('v2 absent');
    return String(filename.endsWith('usage_in_bytes') ? 200 * MiB : 512 * MiB);
  } });
  assert.equal(oldCgroup.limitBytes, 512 * MiB);
});

test('API download and worker storage identities are separate and shared tools have deterministic paths', () => {
  const env = { BACKUP_WORKER_MODE: 'shared', BACKUP_WORKER_AWS_ACCESS_KEY_ID: 'worker', BACKUP_WORKER_AWS_SECRET_ACCESS_KEY: 'worker-secret',
    BACKUP_DOWNLOAD_AWS_ACCESS_KEY_ID: 'download', BACKUP_DOWNLOAD_AWS_SECRET_ACCESS_KEY: 'download-secret' };
  const api = getNativeBackupConfig(env), worker = getNativeBackupConfig({ ...env, BACKUP_PROCESS_ROLE: 'worker' });
  assert.equal(api.credentials.accessKeyId, 'download'); assert.equal(worker.credentials.accessKeyId, 'worker');
  assert.ok(worker.pgDumpPath.endsWith('/dg-postgresql-18.4/bin/pg_dump'));
  assert.equal(worker.shared, true);
  assert.equal(worker.partSize, 5 * 1024 ** 2);
  assert.equal(worker.uploadConcurrency, 1);
  assert.equal(worker.maxArchiveBytes, 40 * 1024 ** 3);
  assert.ok(worker.maxArchiveBytes < worker.partSize * 9999, 'shared defaults must respect the S3 multipart count limit');
});
