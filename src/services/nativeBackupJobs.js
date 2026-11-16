import { randomUUID } from 'node:crypto';

const fail = (message, statusCode = 400, code = 'BACKUP_REQUEST_INVALID') => Object.assign(new Error(message), { statusCode, code });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const iso = value => value == null ? null : new Date(value).toISOString();
const nonnegative = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;

function job(row) {
  if (!row) return null;
  return {
    id: row.id, ownerId: row.owner_id, kind: row.kind, scope: row.scope, sourceJobId: row.source_job_id,
    status: row.status, stage: row.stage, attempt: row.attempt, maxAttempts: row.max_attempts,
    createdAt: iso(row.created_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at),
    availableAt: iso(row.available_at), heartbeatAt: iso(row.heartbeat_at), leaseUntil: iso(row.lease_until),
    leaseToken: row.lease_token, cancelRequested: row.cancel_requested,
    bytes: Number(row.bytes), uploadedBytes: Number(row.uploaded_bytes), checksum: row.checksum,
    verificationStatus: row.verification_status, error: row.error,
    storageDestination: row.storage_destination, artifactPrefix: row.artifact_prefix,
    artifactKey: row.artifact_key, manifestKey: row.manifest_key, metadata: row.metadata,
    expiresAt: iso(row.expires_at),
  };
}

export function publicNativeBackupJob(value) {
  const { ownerId, leaseToken, leaseUntil, artifactPrefix, artifactKey, manifestKey, metadata, sourceJob, ...summary } = value;
  return { ...summary, restoreVerifiedAt: metadata?.restoreVerifiedAt || null, fileCount: metadata?.fileCount || 0 };
}

/** Durable transitions and their audit event commit together. No data extraction. */
export function createNativeBackupJobs(db, config = {}) {
  const retentionDays = config.retentionDays ?? 30;
  const maxAttempts = config.maxAttempts ?? 3;
  const leaseSeconds = config.leaseSeconds ?? 120;
  const prefix = String(config.prefix || 'accounts-backups').replace(/^\/+|\/+$/g, '');
  const storage = config.storageDestination || 'Private S3';
  async function transaction(fn) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='3s'");
      await client.query("SET LOCAL statement_timeout='10s'");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === '23505' && error.constraint === 'native_backup_single_active') throw fail('Another backup or restore verification is already queued or running.', 409, 'BACKUP_ACTIVE');
      throw error;
    } finally { client.release(); }
  }
  async function event(client, id, actorId, action, details = {}) {
    await client.query('INSERT INTO backup_control.events(job_id,actor_id,action,details) VALUES($1,$2,$3,$4::jsonb)', [id, actorId == null ? null : String(actorId), action, JSON.stringify(details)]);
  }
  async function read(client, id, lock = false) {
    if (!uuid(id)) throw fail('Choose a valid backup job.');
    const row = (await client.query(`SELECT * FROM backup_control.jobs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row) throw fail('Backup job was not found.', 404, 'BACKUP_NOT_FOUND');
    return row;
  }
  async function fenced(client, id, token) {
    if (!uuid(id)) throw fail('Choose a valid backup job.');
    const row = (await client.query('SELECT *,lease_until>clock_timestamp() AS lease_valid FROM backup_control.jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    // The database clock owns leases. Worker host clock skew cannot revive an
    // expired attempt or allow it to publish after another host takes over.
    if (!row || row.status !== 'running' || row.lease_token !== token || !row.lease_valid) throw fail('Backup worker lease was lost. This attempt cannot publish a result.', 409, 'BACKUP_LEASE_LOST');
    return row;
  }
  async function failureTransition(client, row, { retryable = true, cancelled = false, message }) {
    const isCancelled = cancelled || row.cancel_requested;
    const retry = !isCancelled && retryable && row.attempt < row.max_attempts;
    const status = isCancelled ? 'cancelled' : retry ? 'queued' : 'failed';
    const delay = Math.min(300, 5 * 2 ** Math.max(0, row.attempt - 1));
    const updated = (await client.query(`UPDATE backup_control.jobs SET status=$2,stage=$2,error=$3,
      available_at=now()+$4::int*interval '1 second',completed_at=CASE WHEN $2='queued' THEN NULL ELSE now() END,
      lease_token=NULL,lease_until=NULL,worker_id=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, status, message, retry ? delay : 0])).rows[0];
    await client.query("UPDATE backup_control.attempts SET status=$3,error=$4,completed_at=now() WHERE job_id=$1 AND attempt=$2", [row.id, row.attempt, status === 'queued' ? 'failed' : status, message]);
    await event(client, row.id, null, isCancelled ? 'cancelled' : retry ? 'retry-scheduled' : 'failed', { attempt: row.attempt });
    return job(updated);
  }
  const store = {
    async enqueue(actorId, { scope = 'database', kind = 'backup', sourceJobId = null } = {}) {
      if (!['database','database-files'].includes(scope) || !['backup','restore-test'].includes(kind)) throw fail('Choose a supported backup scope.');
      if (kind === 'restore-test' && !(config.restoreEnabled ?? Boolean(config.restoreDatabaseUrl))) throw fail('An isolated restore target has not been configured.', 409, 'RESTORE_TARGET_UNAVAILABLE');
      if (kind === 'backup' && sourceJobId !== null) throw fail('Only restore verification can select a source backup.');
      return transaction(async client => {
        if (kind === 'restore-test') {
          const source = await read(client, sourceJobId, true);
          if (source.kind !== 'backup' || source.status !== 'completed' || source.verification_status !== 'verified' || !source.artifact_key) throw fail('Select an available, verified database backup for restoration testing.', 409);
          scope = source.scope;
        }
        const id = randomUUID();
        const row = (await client.query(`INSERT INTO backup_control.jobs(id,owner_id,kind,scope,source_job_id,max_attempts,storage_destination)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, String(actorId), kind, scope, sourceJobId, maxAttempts, storage])).rows[0];
        await event(client, id, actorId, kind === 'backup' ? 'created' : 'restore-test-requested', { scope, sourceJobId });
        return job(row);
      });
    },
    async list({ limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('History limit must be between 1 and 100.');
      return (await db.query('SELECT * FROM backup_control.jobs ORDER BY created_at DESC,id DESC LIMIT $1', [limit])).rows.map(job);
    },
    async get(id) { return job(await read(db, id)); },
    async cancel(id, actorId) {
      return transaction(async client => {
        const row = await read(client, id, true);
        if (!['queued','running'].includes(row.status)) throw fail('Only queued or running jobs can be cancelled.', 409);
        const result = (await client.query(`UPDATE backup_control.jobs SET cancel_requested=true,
          status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
          stage=CASE WHEN status='queued' THEN 'cancelled' ELSE stage END,
          completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END,updated_at=now()
          WHERE id=$1 RETURNING *`, [id])).rows[0];
        await event(client, id, actorId, 'cancel-requested');
        return job(result);
      });
    },
    async retry(id, actorId) {
      return transaction(async client => {
        const row = await read(client, id, true);
        if (!['failed','cancelled'].includes(row.status)) throw fail('Only failed or cancelled jobs can be retried.', 409);
        if (row.kind === 'restore-test') {
          const source = await read(client, row.source_job_id, true);
          if (source.status !== 'completed' || !source.artifact_key) throw fail('The source backup is no longer available for restoration.', 409);
        }
        const result = (await client.query(`UPDATE backup_control.jobs SET status='queued',stage='queued',
          max_attempts=attempt+$2,cancel_requested=false,available_at=now(),completed_at=NULL,error=NULL,
          bytes=0,uploaded_bytes=0,checksum=NULL,artifact_key=NULL,manifest_key=NULL,metadata='{}'::jsonb,
          verification_status='pending',expires_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`, [id, maxAttempts])).rows[0];
        await event(client, id, actorId, 'retry-requested');
        return job(result);
      });
    },
    async claim(workerId) {
      return transaction(async client => {
        const row = (await client.query("SELECT * FROM backup_control.jobs WHERE status='queued' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
        if (!row) return null;
        const token = randomUUID();
        const artifactPrefix = `${prefix}/${row.id}/attempt-${row.attempt + 1}-${token}/`;
        const result = (await client.query(`UPDATE backup_control.jobs SET status='running',stage='starting',attempt=attempt+1,
          started_at=now(),completed_at=NULL,heartbeat_at=now(),lease_until=now()+$3::int*interval '1 second',lease_token=$2,
          worker_id=$4,artifact_prefix=$5,bytes=0,uploaded_bytes=0,checksum=NULL,artifact_key=NULL,manifest_key=NULL,
          verification_status='pending',error=NULL,metadata='{}'::jsonb,updated_at=now() WHERE id=$1 RETURNING *`, [row.id, token, leaseSeconds, String(workerId), artifactPrefix])).rows[0];
        await client.query("INSERT INTO backup_control.attempts(job_id,attempt,lease_token,artifact_prefix,status) VALUES($1,$2,$3,$4,'running')", [row.id, result.attempt, token, artifactPrefix]);
        await event(client, row.id, null, 'started', { attempt: result.attempt });
        const value = job(result);
        if (row.source_job_id) value.sourceJob = job(await read(client, row.source_job_id));
        return value;
      });
    },
    async heartbeat(id, token, progress = {}) {
      return transaction(async client => {
        const row = await fenced(client, id, token);
        const stage = progress.stage ?? row.stage;
        const bytes = progress.bytes ?? row.bytes;
        const uploaded = progress.uploadedBytes ?? row.uploaded_bytes;
        if (typeof stage !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(stage) || !nonnegative(bytes) || !nonnegative(uploaded)) throw fail('Invalid backup progress.');
        const result = (await client.query(`UPDATE backup_control.jobs SET heartbeat_at=now(),lease_until=now()+$3::int*interval '1 second',
          stage=$4,bytes=$5,uploaded_bytes=$6,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING *`, [id, token, leaseSeconds, stage, bytes, uploaded])).rows[0];
        return job(result);
      });
    },
    async complete(id, token, result) {
      return transaction(async client => {
        const row = await fenced(client, id, token);
        if (row.cancel_requested) throw fail('Cancellation was requested before publication.', 409, 'BACKUP_CANCELLED');
        if (row.kind === 'backup' && (result.verificationStatus !== 'verified' || !/^[a-f0-9]{64}$/.test(result.checksum || '') || !nonnegative(result.bytes) || !result.artifactKey?.startsWith(row.artifact_prefix) || !result.manifestKey?.startsWith(row.artifact_prefix))) throw fail('A backup cannot complete before its artifacts and checksum are verified.', 409);
        if (row.kind === 'restore-test' && result.verificationStatus !== 'restored') throw fail('Restoration must complete before verification can succeed.', 409);
        const metadata = { ...(result.metadata || {}) };
        for (const key of ['dbVersion','toolVersion','fileCount','manifestChecksum','restoredTables','restoreDurationMs']) if (result[key] !== undefined) metadata[key] = result[key];
        const updated = (await client.query(`UPDATE backup_control.jobs SET status='completed',stage='completed',completed_at=now(),
          bytes=$3,uploaded_bytes=$4,checksum=$5,verification_status=$6,artifact_key=$7,manifest_key=$8,metadata=$9::jsonb,
          expires_at=CASE WHEN kind='backup' THEN now()+$10::int*interval '1 day' ELSE NULL END,
          lease_token=NULL,lease_until=NULL,worker_id=NULL,error=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 RETURNING *`,
        [id, token, result.bytes || 0, result.uploadedBytes ?? result.bytes ?? 0, result.checksum || null, result.verificationStatus,
          result.artifactKey || null, result.manifestKey || null, JSON.stringify(metadata), retentionDays])).rows[0];
        await client.query("UPDATE backup_control.attempts SET status='completed',completed_at=now() WHERE job_id=$1 AND attempt=$2", [id, row.attempt]);
        await event(client, id, null, row.kind === 'backup' ? 'completed' : 'restore-test-completed', { attempt: row.attempt });
        if (row.kind === 'restore-test' && row.source_job_id) {
          await client.query("UPDATE backup_control.jobs SET metadata=metadata || jsonb_build_object('restoreVerifiedAt',now(),'restoreVerificationJobId',$2::text),updated_at=now() WHERE id=$1", [row.source_job_id,id]);
          await event(client, row.source_job_id, null, 'restore-verified', { verificationJobId: id });
        }
        return job(updated);
      });
    },
    async fail(id, token, error, { retryable = true, cancelled = false } = {}) {
      return transaction(async client => {
        const row = await fenced(client, id, token);
        // Never persist raw database/tool errors: stderr can contain credentials,
        // SQL and business values. Operators correlate the attempt and safe code.
        const code = String(error?.code || 'BACKUP_ATTEMPT_FAILED');
        const safeCode = /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'BACKUP_ATTEMPT_FAILED';
        return failureTransition(client, row, { retryable, cancelled, message: cancelled || row.cancel_requested ? 'Cancelled by request.' : `Backup attempt failed (${safeCode}). Check worker diagnostics for this job and attempt.` });
      });
    },
    // Caller must own the global worker advisory lock before recovery. A new
    // lease and artifact prefix are issued; interrupted dumps never resume.
    async recover() {
      return transaction(async client => {
        const rows = (await client.query("SELECT * FROM backup_control.jobs WHERE status='running' AND lease_until<=now() FOR UPDATE SKIP LOCKED")).rows;
        const recovered = [];
        for (const row of rows) recovered.push(await failureTransition(client, row, { message: 'Worker heartbeat expired; the interrupted attempt was discarded.' }));
        return recovered;
      });
    },
    async audit(id, actorId, action, details = {}) {
      return transaction(async client => { await read(client, id); await event(client, id, actorId, action, details); });
    },
    async file(id, fileId) {
      if (!/^[a-f0-9]{64}$/.test(fileId || '')) throw fail('Choose a valid backup file.');
      const current = await store.get(id);
      const row = (await db.query('SELECT metadata FROM backup_control.files WHERE job_id=$1 AND attempt=$2 AND file_id=$3', [id,current.attempt,fileId])).rows[0];
      if (!row?.metadata?.artifactKey?.startsWith(current.artifactPrefix) || !/^[a-f0-9]{64}$/.test(row.metadata.checksum || '')) throw fail('Backup file was not found.',404);
      return row.metadata;
    },
    async cleanupCandidates() {
      return (await db.query(`SELECT a.job_id,a.attempt,a.artifact_prefix FROM backup_control.attempts a
        WHERE a.status IN ('failed','cancelled') AND a.cleaned_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM backup_control.jobs j WHERE j.id=a.job_id AND j.attempt=a.attempt AND j.status IN ('running','completed'))
        ORDER BY a.started_at LIMIT 20`)).rows.map(row => ({ jobId: row.job_id, attempt: row.attempt, artifactPrefix: row.artifact_prefix }));
    },
    async markAttemptCleaned(id, attempt) {
      return transaction(async client => {
        const result = await client.query(`UPDATE backup_control.attempts a SET cleaned_at=now()
          WHERE job_id=$1 AND attempt=$2 AND status IN ('failed','cancelled') AND cleaned_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM backup_control.jobs j WHERE j.id=a.job_id AND j.attempt=a.attempt AND j.status IN ('running','completed')) RETURNING attempt`,[id,attempt]);
        if (result.rows.length) await event(client,id,null,'attempt-cleaned',{attempt});
        if (result.rows.length) await client.query('DELETE FROM backup_control.files WHERE job_id=$1 AND attempt=$2',[id,attempt]);
        return result.rows.length > 0;
      });
    },
    async expired({ limit = 20 } = {}) {
      return (await db.query(`SELECT * FROM backup_control.jobs j WHERE status='deleting' OR
        (status='completed' AND kind='backup' AND expires_at<=now()
        AND EXISTS(SELECT 1 FROM backup_control.jobs newer WHERE newer.kind='backup' AND newer.status='completed' AND newer.verification_status='verified' AND newer.completed_at>j.completed_at AND (newer.scope=j.scope OR newer.scope='database-files'))
        AND NOT EXISTS(SELECT 1 FROM backup_control.jobs r WHERE r.source_job_id=j.id AND r.status IN ('queued','running')))
        ORDER BY expires_at LIMIT $1`, [limit])).rows.map(job);
    },
    async claimDeletion(id) {
      return transaction(async client => {
        const row = await read(client, id, true);
        if (row.status === 'deleting') return job(row);
        if (row.status !== 'completed' || !row.expires_at || new Date(row.expires_at).getTime() > Date.now()) throw fail('Backup retention has not expired.', 409);
        if (!(await client.query("SELECT 1 FROM backup_control.jobs WHERE kind='backup' AND status='completed' AND verification_status='verified' AND completed_at>$1 AND (scope=$2 OR scope='database-files') LIMIT 1", [row.completed_at,row.scope])).rows.length) throw fail('The newest verified backup covering this scope must be retained.', 409);
        if ((await client.query("SELECT 1 FROM backup_control.jobs WHERE source_job_id=$1 AND status IN ('queued','running')", [id])).rows.length) throw fail('Backup is being used by restoration verification.', 409);
        const result = (await client.query("UPDATE backup_control.jobs SET status='deleting',stage='retention-cleanup',updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0];
        await event(client, id, null, 'retention-deletion-started');
        return job(result);
      });
    },
    async markDeleted(id) {
      return transaction(async client => {
        const row = await read(client, id, true);
        if (row.status !== 'deleting') throw fail('Backup must be reserved for retention cleanup before deletion.', 409);
        const result = (await client.query("UPDATE backup_control.jobs SET status='expired',stage='expired',updated_at=now() WHERE id=$1 RETURNING *", [id])).rows[0];
        await client.query('DELETE FROM backup_control.files WHERE job_id=$1',[id]);
        await event(client, id, null, 'retention-deleted');
        return job(result);
      });
    },
  };
  return store;
}
