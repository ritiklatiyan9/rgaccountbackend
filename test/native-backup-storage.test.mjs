import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createNativeBackupStorage, byteMeter } from '../src/services/nativeBackupStorage.js';
import { getNativeBackupConfig, nativePostgresEnvironment, validateRestoreTarget } from '../src/services/nativeBackupConfig.js';
import { runNative } from '../src/services/nativeBackupProcess.js';

const config = { prefix: 'private-backups', bucket: 'fixture', region: 'us-east-1', partSize: 5 * 1024 ** 2, uploadConcurrency: 1, maxArchiveBytes: 100 * 1024 ** 2 };
const key = 'private-backups/11111111-1111-1111-1111-111111111111/attempt-1-22222222-2222-2222-2222-222222222222/database.dump';

test('bounded upload passes private encryption and fixed multipart budget, then checks readback hash', async () => {
  let options; let saved; let count = 0;
  class FakeUpload extends EventEmitter {
    constructor(value) { super(); options = value; }
    async done() {
      const chunks = [];
      for await (const chunk of options.params.Body) { chunks.push(chunk); count += chunk.length; this.emit('httpUploadProgress', { loaded: count }); }
      saved = Buffer.concat(chunks); return { VersionId: 'v1' };
    }
    async abort() {}
  }
  const client = { send: async () => ({ Body: Readable.from([saved]) }) };
  const storage = createNativeBackupStorage(config, { client, UploadClass: FakeUpload });
  const progress = [];
  const result = await storage.upload(key, Readable.from([Buffer.alloc(1024, 3), Buffer.alloc(1024, 7)]), { onProgress: bytes => progress.push(bytes) });
  assert.equal(result.bytes, 2048); assert.equal(result.versionId, 'v1');
  assert.equal(result.checksum, createHash('sha256').update(saved).digest('hex'));
  assert.equal(options.params.ACL, undefined); assert.equal(options.params.ServerSideEncryption, 'AES256');
  assert.equal(options.queueSize, 1); assert.equal(options.partSize, config.partSize); assert.equal(options.leavePartsOnError, false);
  assert.equal(progress.at(-1), 2048);
  await storage.verify(key, result);
  saved[0] ^= 1;
  await assert.rejects(storage.verify(key, result), /checksum/);
});

test('upload rejection and cancellation abort multipart upload and destroy its source', async () => {
  let aborted = 0;
  class FailedUpload extends EventEmitter {
    async done() { throw Object.assign(new Error('fixture storage denied'), { code: 'AccessDenied' }); }
    async abort() { aborted++; }
  }
  const storage = createNativeBackupStorage(config, { client: {}, UploadClass: FailedUpload });
  const input = Readable.from((async function* () { while (true) yield Buffer.alloc(65536); })());
  await assert.rejects(storage.upload(key, input), /fixture storage denied/);
  assert.ok(input.destroyed); assert.ok(aborted > 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(storage.upload(key, Readable.from([Buffer.alloc(1024)]), { signal: controller.signal }));
});

test('size limit fails with cleanup instead of accepting a partial object', async () => {
  let aborted = false; let input;
  class LimitedUpload extends EventEmitter {
    constructor(options) { super(); input = options.params.Body; }
    async done() { for await (const _chunk of input) {} return {}; }
    async abort() { aborted = true; }
  }
  const storage = createNativeBackupStorage({ ...config, maxArchiveBytes: 100 }, { client: {}, UploadClass: LimitedUpload });
  await assert.rejects(storage.upload(key, Readable.from([Buffer.alloc(101)])), /size limit/);
  assert.equal(aborted, true);
});

test('cleanup is attempt-scoped and surfaces S3 partial delete failures', async () => {
  const requests = [];
  const client = { send: async command => {
    requests.push(command);
    return command.constructor.name === 'ListObjectsV2Command' ? { Contents: [{ Key: key }] } : { Errors: [{ Code: 'AccessDenied' }] };
  } };
  const storage = createNativeBackupStorage(config, { client });
  await assert.rejects(storage.removePrefix('private-backups/'), /cleanup prefix/);
  await assert.rejects(storage.read('other-bucket/data'), /artifact key/);
  await assert.rejects(storage.removePrefix(key.slice(0, key.lastIndexOf('/') + 1)), /cleanup failed/);
  assert.equal(requests.length, 2);
});

test('stream meter propagates insufficient disk/storage errors without buffering source', async () => {
  const meter = byteMeter();
  const output = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })); } });
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(1024)]), meter.stream, output), { code: 'ENOSPC' });
});

test('native subprocess cancellation terminates child and does not expose stderr records', async () => {
  const controller = new AbortController();
  const operation = runNative(process.execPath, ['-e', "process.stderr.write('confidential fixture'); setInterval(()=>{},1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(operation.done, error => !error.message.includes('confidential') && error.message.includes('tool failed'));
  assert.ok(operation.child.killed);
  const missing = runNative('/nonexistent-backup-test-tool', []);
  await assert.rejects(missing.done, /could not be started/);
});

test('configuration rejects unsafe restore destinations and never puts credentials in arguments', () => {
  const cfg = getNativeBackupConfig({ BACKUP_DATABASE_URL: 'postgres://source:secret@db.example/erp?sslmode=verify-full', BACKUP_RESTORE_DATABASE_URL: 'postgres://restore:secret@127.0.0.1/backup_verify_fixture' });
  assert.equal(nativePostgresEnvironment(cfg.database).PGPASSWORD, 'secret');
  assert.equal(nativePostgresEnvironment(cfg.database).PGSSLMODE, 'verify-full');
  assert.deepEqual(validateRestoreTarget(cfg), { connectionString: cfg.restoreDatabaseUrl });
  for (const target of ['postgres://localhost/erp', 'postgres://remote.example/backup_verify_fixture', 'postgres://localhost/postgres']) {
    assert.throws(() => validateRestoreTarget({ ...cfg, restoreDatabaseUrl: target }), /separate local/);
  }
  assert.throws(() => getNativeBackupConfig({ BACKUP_UPLOAD_CONCURRENCY: '200' }), /Invalid/);
  assert.equal(getNativeBackupConfig({}).filesEnabled, false);
  assert.throws(() => getNativeBackupConfig({ BACKUP_ENABLED: 'true', BACKUP_S3_BUCKET: 'fixture', BACKUP_DATABASE_URL: 'postgres://source@remote.example/erp' }), /verified TLS/);
});
