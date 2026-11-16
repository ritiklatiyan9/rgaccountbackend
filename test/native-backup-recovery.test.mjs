import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { recoverNativeFiles } from '../src/services/nativeBackupRecovery.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function setup(t, { unsafe = false, changed = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-recovery-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prefix = 'backups/fixture/attempt-1-fixture/';
  const job = { id: 'fixture', scope: 'database-files', status: 'completed', verificationStatus: 'verified', artifactPrefix: prefix, manifestKey: `${prefix}manifest.json` };
  const file = Buffer.from('original');
  const fileKey = `${prefix}files/${'a'.repeat(64)}`;
  const entry = { storage: 'local', key: unsafe ? '../escape.txt' : 'kyc_documents/fixture.txt', artifactKey: fileKey, bytes: file.length, checksum: hash(file) };
  const index = Buffer.from(`${JSON.stringify(entry)}\n`);
  const manifest = Buffer.from(JSON.stringify({ format: 'rgaccounts-native-backup', version: 1, jobId: job.id,
    files: { count: 1, bytes: file.length, manifestKey: `${prefix}files.ndjson`, manifestChecksum: hash(index), manifestBytes: index.length } }));
  job.metadata = { manifestChecksum: hash(manifest) };
  const objects = new Map([[job.manifestKey, manifest], [`${prefix}files.ndjson`, index], [fileKey, file]]);
  let indexVerified = false;
  const storage = {
    async read(key) {
      if (changed && indexVerified && key.endsWith('files.ndjson')) {
        const replacement = Buffer.from('modified');
        objects.set(fileKey, replacement);
        return Readable.from([Buffer.from(`${JSON.stringify({ ...entry, checksum: hash(replacement) })}\n`)]);
      }
      return Readable.from([objects.get(key)]);
    },
    async verify(key, expected, { consumer } = {}) {
      const value = objects.get(key);
      assert.equal(value.length, expected.bytes); assert.equal(hash(value), expected.checksum);
      if (key.endsWith('files.ndjson')) indexVerified = true;
      if (consumer) await pipeline(Readable.from([value]), consumer);
    },
  };
  return { job, storage, directory: path.join(root, 'new-recovery') };
}

test('file restoration stages verified bytes privately and refuses existing directories', async t => {
  const input = await setup(t);
  const result = await recoverNativeFiles(input);
  assert.deepEqual(result, { count: 1, bytes: 8 });
  assert.equal(await fs.readFile(path.join(input.directory, 'local/kyc_documents/fixture.txt'), 'utf8'), 'original');
  assert.equal((await fs.stat(input.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(input.directory, 'local/kyc_documents/fixture.txt'))).mode & 0o777, 0o600);
  await assert.rejects(fs.access(path.join(input.directory, 'RECOVERY_INCOMPLETE')));
  await assert.rejects(recoverNativeFiles(input), { code: 'EEXIST' });
});

test('inventory tampering between verification and reading never publishes recovery success', async t => {
  const input = await setup(t, { changed: true });
  await assert.rejects(recoverNativeFiles(input), /changed after verification/);
  await fs.access(path.join(input.directory, 'RECOVERY_INCOMPLETE'));
  await assert.rejects(fs.access(path.join(input.directory, 'RECOVERY_VERIFIED.json')));
});

test('unsafe file keys and excessive recovery budgets fail without publishing files', async t => {
  const input = await setup(t, { unsafe: true });
  await assert.rejects(recoverNativeFiles(input), /Unsafe/);
  await assert.rejects(fs.access(path.resolve(input.directory, '../escape.txt')));
  const limited = await setup(t);
  await assert.rejects(recoverNativeFiles({ ...limited, maxBytes: 1 }), /oversized/);
  await assert.rejects(fs.access(limited.directory));
});
