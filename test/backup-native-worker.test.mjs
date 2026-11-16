import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { migrationSql } from '../src/migrations/249_native_backups.js';
import { createNativeBackupJobs } from '../src/services/nativeBackupJobs.js';
import { runBackupWorker } from '../src/workers/backupWorker.js';
import { backupWorkerAvailable } from '../src/services/backupWorkerAvailability.js';

const result = job => ({bytes:12,checksum:'d'.repeat(64),verificationStatus:'verified',artifactKey:`${job.artifactPrefix}database.dump`,manifestKey:`${job.artifactPrefix}manifest.json`});
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };
const untilAbort = signal => new Promise((resolve,reject) => { if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); });

test('isolated native worker failure injection and lifecycle on real PostgreSQL', { skip: !process.env.BACKUP_NATIVE_WORKER_TEST_DATABASE_URL, timeout: 30000 }, async t => {
  const url = new URL(process.env.BACKUP_NATIVE_WORKER_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
  assert.match(url.pathname,/backup_worker_test$/);
  const {default:pg} = await import('pg');
  const pool = new pg.Pool({connectionString:url.href,max:8});
  t.after(()=>pool.end());
  await pool.query(migrationSql);
  const config = {enabled:true,leaseSeconds:1,timeoutMs:3000,pollMs:20,maxAttempts:2,retentionDays:30,prefix:'worker-tests'};
  const jobs = createNativeBackupJobs(pool,config);
  let removed=[];let logs=[];
  const storage={removePrefix:async prefix=>removed.push(prefix)};
  async function reset() {
    await pool.query('TRUNCATE backup_control.events,backup_control.files,backup_control.attempts,backup_control.jobs');
    removed=[];logs=[];
  }
  const worker = options => runBackupWorker({pool,config,storage,once:true,log:value=>logs.push(value),...options});

  await t.test('publishes only verified artifacts and releases its session lock',async()=>{
    await reset();const created=await jobs.enqueue(1);
    await worker({backup:async({job,progress})=>{progress({stage:'verifying',bytes:12});return result(job);}});
    const completed=await jobs.get(created.id);
    assert.equal(completed.status,'completed');
    assert.ok(logs.some(log=>log.event==='backup-completed'));
    const client=await pool.connect();
    try {
      assert.equal((await client.query('SELECT pg_try_advisory_lock(734921,1) AS acquired')).rows[0].acquired,true);
      await client.query('SELECT pg_advisory_unlock(734921,1)');
    }finally{client.release();}
  });
  await t.test('a second worker cannot overlap a running native process',async()=>{
    await reset();await jobs.enqueue(1);
    const started=deferred(),finish=deferred();let calls=0;
    const running=worker({backup:async({job})=>{calls++;started.resolve();await finish.promise;return result(job);}});
    await started.promise;
    try {
      await worker({backup:async()=>{calls++;assert.fail('overlapping process');}});
      assert.equal(calls,1);
      assert.ok(logs.some(log=>log.event==='backup-worker-standby'));
    }finally{finish.resolve();await running;}
  });
  await t.test('legacy maintenance restore transaction excludes the native worker',async()=>{
    await reset();const queued=await jobs.enqueue(1);const legacy=await pool.connect();
    try {
      await legacy.query('BEGIN');await legacy.query('SELECT pg_advisory_xact_lock(734921,1)');
      await worker({backup:async()=>assert.fail('must not overlap legacy restore')});
      assert.equal((await jobs.get(queued.id)).status,'queued');
      assert.ok(logs.some(log=>log.event==='backup-worker-standby'));
    }finally{await legacy.query('ROLLBACK');legacy.release();}
  });
  await t.test('API sees a worker only while its dedicated session lock is held', async () => {
    const holder = await pool.connect();
    try {
      assert.equal(await backupWorkerAvailable(pool), false);
      await holder.query("SET application_name='accounts-backup-metadata'");
      await holder.query('SELECT pg_advisory_lock(734921,1)');
      assert.equal(await backupWorkerAvailable(pool), true);
      await holder.query('SELECT pg_advisory_unlock(734921,1)');
      assert.equal(await backupWorkerAvailable(pool), false);
    } finally { holder.release(true); }
  });
  await t.test('shared host load defers queued work and memory pressure aborts an attempt safely', async () => {
    await reset(); const queued = await jobs.enqueue(1);
    await worker({ config: { ...config, shared: true }, memory: async () => ({ usedBytes: 400, limitBytes: 512, rss: 80 * 1024 ** 2 }), backup: async () => assert.fail('busy host must defer work') });
    assert.equal((await jobs.get(queued.id)).attempt, 0);
    let samples = 0;
    await worker({ config: { ...config, shared: true }, memory: async () => ({ usedBytes: ++samples === 1 ? 100 : 450, limitBytes: 512, rss: 80 * 1024 ** 2 }),
      backup: async ({ signal }) => untilAbort(signal) });
    const interrupted = await jobs.get(queued.id);
    assert.equal(interrupted.status, 'queued'); assert.match(interrupted.error, /BACKUP_RESOURCE_PRESSURE/);
    assert.equal(interrupted.artifactKey, null);
  });
  await t.test('interrupted upload fails, schedules a fresh attempt, and cleans abandoned objects',async()=>{
    await reset();const created=await jobs.enqueue(1);
    await worker({backup:async()=>{throw Object.assign(new Error('private SQL and password=do-not-log'),{code:'ECONNRESET'});}});
    assert.equal((await jobs.get(created.id)).status,'queued');
    assert.doesNotMatch(JSON.stringify(logs),/private SQL|do-not-log/);
    const attempt=(await jobs.cleanupCandidates())[0];
    assert.ok(attempt.artifactPrefix);
    await worker({backup:async()=>assert.fail('backoff should prevent immediate retry')});
    assert.deepEqual(removed,[attempt.artifactPrefix]);
    assert.equal((await jobs.cleanupCandidates()).length,0);
    assert.ok((await pool.query('SELECT cleaned_at FROM backup_control.attempts')).rows[0].cleaned_at);
  });
  await t.test('cancellation is observed by heartbeat and aborts the native operation before publication',async()=>{
    await reset();const created=await jobs.enqueue(1);const started=deferred();
    const running=worker({backup:async({signal})=>{started.resolve();await untilAbort(signal);assert.fail('cancelled pipeline completed');}});
    await started.promise;await jobs.cancel(created.id,1);await running;
    const cancelled=await jobs.get(created.id);
    assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.artifactKey,null);
  });
  await t.test('timeout aborts a stalled operation and persists retryable failure',async()=>{
    await reset();const created=await jobs.enqueue(1);
    await worker({config:{...config,timeoutMs:35},backup:async({signal})=>untilAbort(signal)});
    const timedOut=await jobs.get(created.id);
    assert.equal(timedOut.status,'queued');assert.match(timedOut.error,/BACKUP_TIMEOUT/);
  });
  await t.test('graceful shutdown aborts the current process and leaves durable retry state',async()=>{
    await reset();const created=await jobs.enqueue(1);const started=deferred();const shutdown=new AbortController();
    const running=worker({signal:shutdown.signal,backup:async({signal})=>{started.resolve();return untilAbort(signal);}});
    await started.promise;shutdown.abort();await running;
    assert.equal((await jobs.get(created.id)).status,'queued');
  });
  await t.test('metadata connection loss stops the worker without publishing a successful artifact',async()=>{
    await reset();const created=await jobs.enqueue(1);
    await worker({backup:async({signal})=>{
      const aborted=untilAbort(signal);
      pool.emit('error',Object.assign(new Error('connection lost'),{code:'ECONNRESET'}));
      return aborted;
    }});
    assert.equal((await jobs.get(created.id)).status,'queued');
    assert.ok(logs.some(log=>log.event==='backup-lock-lost'));
    assert.ok(!logs.some(log=>log.event==='backup-completed'));
  });
  await t.test('lease fencing aborts stale worker; expired crash attempt is recovered and cleaned',async()=>{
    await reset();const created=await jobs.enqueue(1);const started=deferred();
    const running=worker({backup:async({signal})=>{started.resolve();return untilAbort(signal);}});
    await started.promise;
    await pool.query('UPDATE backup_control.jobs SET lease_token=$2 WHERE id=$1',[created.id,randomUUID()]);
    await running;
    assert.equal((await jobs.get(created.id)).status,'running');
    await pool.query("UPDATE backup_control.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[created.id]);
    await worker({backup:async()=>assert.fail('recovery should schedule backoff')});
    assert.equal((await jobs.get(created.id)).status,'queued');
    assert.equal(removed.length,1);
    assert.equal((await jobs.cleanupCandidates()).length,0);
  });
  await t.test('cleanup permission failure is durable and does not erase the cleanup obligation',async()=>{
    await reset();const created=await jobs.enqueue(1);
    await worker({backup:async()=>{throw Object.assign(new Error('permission denied'),{code:'EACCES'});}});
    await worker({storage:{removePrefix:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});}},backup:async()=>assert.fail('backoff')});
    assert.equal((await jobs.cleanupCandidates()).length,1);
    assert.equal((await jobs.get(created.id)).status,'queued');
    assert.ok(logs.some(log=>log.event==='backup-cleanup-failed'));
  });
  await t.test('shutdown during orphan cleanup must not start the next queued process',async()=>{
    await reset();const first=await jobs.enqueue(1);const active=await jobs.claim('crashed');
    await jobs.fail(first.id,active.leaseToken,new Error('failed'),{retryable:false});
    const next=await jobs.enqueue(1);const shutdown=new AbortController();
    await worker({signal:shutdown.signal,storage:{removePrefix:async()=>shutdown.abort()},backup:async()=>assert.fail('must not run after shutdown')});
    assert.equal((await jobs.get(next.id)).status,'queued');
  });
});
