import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { byteMeter } from '../../src/services/nativeBackupStorage.js';

export function isolatedTestUrl(value, { allowVerification = false } = {}) {
  if (!value) throw new Error('Set BACKUP_NATIVE_TEST_DATABASE_URL explicitly to a disposable local *_test database.');
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || (!url.pathname.endsWith('_test') && !(allowVerification && url.pathname.startsWith('/backup_verify_')))) {
    throw new Error('Native integration tests accept only explicit local disposable *_test databases.');
  }
  return url;
}

/** Local adapter exercises streaming engine; it does not emulate S3 multipart semantics. */
export function fixtureStorage(root, { maxBytes = 2 ** 40, onChunk } = {}) {
  const filename = key => {
    const resolved = path.resolve(root, key);
    if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Unsafe fixture storage key.');
    return resolved;
  };
  const storage = {
    filename,
    async upload(key, input, { signal, onProgress = () => {} } = {}) {
      const target = filename(key); await fs.mkdir(path.dirname(target), { recursive: true });
      const meter = byteMeter({ maxBytes, onBytes(bytes) { onProgress(bytes); onChunk?.(bytes); } });
      await pipeline(input, meter.stream, createWriteStream(target, { mode: 0o600 }), { signal });
      return meter.result();
    },
    async read(key) { return createReadStream(filename(key)); },
    async verify(key, expected, { signal, consumer } = {}) {
      const meter = byteMeter({ maxBytes });
      await pipeline(createReadStream(filename(key)), meter.stream,
        consumer || new Writable({ write(_value, _encoding, done) { done(); } }), { signal });
      const result = meter.result();
      if (result.bytes !== Number(expected.bytes) || result.checksum !== expected.checksum) throw new Error('Stored backup checksum verification failed.');
      return result;
    },
    async removePrefix(prefix) { await fs.rm(filename(prefix), { recursive: true, force: true }); },
  };
  return storage;
}
