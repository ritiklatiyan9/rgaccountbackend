import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import {
  BACKUP_FORMAT, BACKUP_VERSION, BackupError, decodeBackup, encodeBackup,
  getBackupLimits, sha256Payload, stableStringify,
} from '../src/services/backupArchive.js';

const fixture = () => ({
  backupId: '81a37b3c-9016-4c12-bf7c-d8f5c39a1f19',
  createdAt: '2026-10-02T11:00:00.000Z',
  month: '2026-10',
  kind: 'full',
  requestedModules: [],
  schema: { tables: [{ name: 'transactions', columns: [{ name: 'amount', type: 'numeric' }] }] },
  tables: [{
    name: 'transactions', module: 'accounts', columns: ['id', 'amount', 'memo', 'metadata', 'received_at'],
    rows: [
      ['9223372036854775807', '99999999999999999999.123456789000', '₹ हिन्दी 🏠', '{"constructor":"stored JSON value"}', '2026-10-02 10:22:33.123456+05:30'],
      ['2', '-0.00000001', null, '{}', null],
    ],
  }],
  sequences: [{ name: 'transactions_id_seq', lastValue: '9223372036854775807', isCalled: true }],
  attachments: { storage: 'external', included: false },
});

function rawArchive(payload = fixture(), changes = {}) {
  return gzipSync(JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, checksum: sha256Payload(payload), payload, ...changes }));
}

async function withLimits(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('gzip backup round trip preserves exact decimal, bigint, timestamp, JSON, unicode, and null values', async () => {
  const payload = fixture();
  const archive = await encodeBackup(payload);
  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);
  const result = await decodeBackup(archive);
  assert.deepEqual(result.payload, payload);
  assert.equal(result.checksum, sha256Payload(payload));
  assert.equal(JSON.parse(gunzipSync(archive)).version, 1);
});

test('canonical checksums ignore object property order and preserve array order', () => {
  assert.equal(stableStringify({ z: { b: 2, a: 1 }, a: [null, '₹'] }), '{"a":[null,"₹"],"z":{"a":1,"b":2}}');
  assert.equal(sha256Payload({ b: 2, a: 1 }), sha256Payload({ a: 1, b: 2 }));
  assert.notEqual(sha256Payload({ rows: ['1', '2'] }), sha256Payload({ rows: ['2', '1'] }));
});

test('valid module and empty-table backups can be decoded', async () => {
  const payload = fixture();
  payload.kind = 'modules';
  payload.requestedModules = ['accounts'];
  payload.tables[0].rows = [];
  delete payload.attachments;
  assert.deepEqual((await decodeBackup(await encodeBackup(payload))).payload, payload);
});

test('a changed cell fails checksum verification even when gzip is intact', async () => {
  const payload = fixture();
  const checksum = sha256Payload(payload);
  payload.tables[0].rows[0][1] = '0.01';
  await assert.rejects(decodeBackup(rawArchive(payload, { checksum })), /integrity check failed/);
});

test('truncated and CRC-corrupted gzip files are rejected', async () => {
  const archive = await encodeBackup(fixture());
  await assert.rejects(decodeBackup(archive.subarray(0, -5)), /damaged|incomplete/);
  const corrupt = Buffer.from(archive);
  corrupt[corrupt.length - 8] ^= 0xff;
  await assert.rejects(decodeBackup(corrupt), /damaged|incomplete/);
});

test('empty, uncompressed, non-JSON, and invalid UTF-8 uploads are rejected', async () => {
  for (const data of [Buffer.alloc(0), Buffer.from('{}'), gzipSync('not json'), gzipSync(Buffer.from([0xff]))]) {
    await assert.rejects(decodeBackup(data), BackupError);
  }
  await assert.rejects(decodeBackup('not a Buffer'), BackupError);
});

test('foreign formats, unsupported versions, unexpected envelope fields, and malformed checksums are rejected', async () => {
  for (const [changes, pattern] of [
    [{ format: 'another-app' }, /not an RG Accounts backup/],
    [{ version: 2 }, /version is not supported/],
    [{ version: '1' }, /version is not supported/],
    [{ extra: 'unrecognized' }, /unexpected field/],
    [{ checksum: 'bad' }, /checksum is missing or invalid/],
    [{ checksum: null }, /checksum is missing or invalid/],
  ]) await assert.rejects(decodeBackup(rawArchive(fixture(), changes)), pattern);
});

test('duplicate table names, columns, and requested modules are rejected on export and import', async () => {
  for (const [change, pattern] of [
    [p => p.tables.push(structuredClone(p.tables[0])), /duplicate table/],
    [p => p.tables[0].columns.push('id'), /duplicate columns/],
    [p => { p.requestedModules = ['accounts', 'accounts']; }, /duplicate requested modules/],
  ]) {
    const payload = fixture();
    change(payload);
    await assert.rejects(encodeBackup(payload), pattern);
    await assert.rejects(decodeBackup(rawArchive(payload)), pattern);
  }
});

test('row widths and nonstring database values fail instead of losing precision', async () => {
  for (const change of [
    p => p.tables[0].rows[0].pop(),
    p => p.tables[0].rows[0].push('extra'),
    p => { p.tables[0].rows[0][1] = 123.45; },
    p => { p.tables[0].rows[0][1] = { value: '123.45' }; },
    p => { p.tables[0].rows[0] = {}; },
  ]) {
    const payload = fixture();
    change(payload);
    await assert.rejects(encodeBackup(payload), /row width|strings or null/);
    await assert.rejects(decodeBackup(rawArchive(payload)), /row width|strings or null/);
  }
});

test('required metadata and structural fields are validated', async () => {
  for (const changes of [
    { backupId: 'missing' }, { createdAt: '2026-02-30T11:00:00.000Z' },
    { createdAt: '2026-10-02' }, { month: '2026-13' }, { month: '2026-1' },
    { kind: 'unknown' }, { kind: 'modules', requestedModules: [] }, { requestedModules: [42] },
    { schema: {} }, { schema: [] }, { tables: {} }, { sequences: {} }, { attachments: [] },
  ]) {
    const payload = { ...fixture(), ...changes };
    await assert.rejects(encodeBackup(payload), BackupError);
    await assert.rejects(decodeBackup(rawArchive(payload)), BackupError);
  }
});

test('prototype pollution keys anywhere in payload are rejected without modifying prototypes', async () => {
  for (const key of ['__proto__', 'prototype', 'constructor']) {
    const payload = fixture();
    payload.schema.metadata = JSON.parse(`{"${key}":{"backupPolluted":true}}`);
    assert.throws(() => stableStringify(payload), /prohibited object key/);
    await assert.rejects(encodeBackup(payload), /prohibited object key/);
    const archive = gzipSync(JSON.stringify({ format: BACKUP_FORMAT, version: 1, checksum: '0'.repeat(64), payload }));
    await assert.rejects(decodeBackup(archive), /prohibited object key/);
  }
  assert.equal({}.backupPolluted, undefined);
});

test('cyclic objects, non-JSON numbers/types, and excessive nesting fail predictably', async () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => stableStringify(cyclic), /circular/);
  for (const value of [NaN, Infinity, undefined, 1n, new Date(), () => {}]) {
    assert.throws(() => stableStringify({ value }), /JSON/);
  }
  const payload = fixture();
  let nested = payload.schema;
  for (let i = 0; i < 70; i += 1) nested = nested.next = {};
  const archive = gzipSync(JSON.stringify({ format: BACKUP_FORMAT, version: 1, checksum: '0'.repeat(64), payload }));
  await assert.rejects(decodeBackup(archive), /nesting depth/);
});

test('upload size is checked before decompression', async () => {
  await withLimits({ BACKUP_MAX_UPLOAD_MB: '1' }, async () => {
    await assert.rejects(decodeBackup(Buffer.alloc(1024 * 1024 + 1)), error => error.status === 413 && /upload size/.test(error.message));
  });
});

test('expansion bombs are stopped at the decompressed byte limit', async () => {
  await withLimits({ BACKUP_MAX_EXPANDED_MB: '1' }, async () => {
    const payload = fixture();
    payload.tables[0].rows[0][2] = 'x'.repeat(2 * 1024 * 1024);
    const compressed = rawArchive(payload);
    assert.ok(compressed.length < 10_000);
    await assert.rejects(decodeBackup(compressed), error => error.statusCode === 413 && /expanded size/.test(error.message));
    await assert.rejects(encodeBackup(payload), error => error.status === 413);
  });
});

test('exports cannot produce archives exceeding the configured upload limit', async () => {
  await withLimits({ BACKUP_MAX_UPLOAD_MB: '1', BACKUP_MAX_EXPANDED_MB: '4' }, async () => {
    const payload = fixture();
    payload.tables[0].rows[0][2] = randomBytes(1200 * 1024).toString('base64');
    await assert.rejects(encodeBackup(payload), error => error.status === 413 && /upload size/.test(error.message));
  });
});

test('size configuration has safe defaults and hard ceilings', async () => {
  await withLimits({ BACKUP_MAX_UPLOAD_MB: undefined, BACKUP_MAX_EXPANDED_MB: undefined }, async () => {
    assert.deepEqual(getBackupLimits(), { maxUploadBytes: 100 * 1024 ** 2, maxExpandedBytes: 100 * 1024 ** 2 });
  });
  await withLimits({ BACKUP_MAX_UPLOAD_MB: '9999999', BACKUP_MAX_EXPANDED_MB: '9999999' }, async () => {
    assert.deepEqual(getBackupLimits(), { maxUploadBytes: 500 * 1024 ** 2, maxExpandedBytes: 1024 * 1024 ** 2 });
  });
  await withLimits({ BACKUP_MAX_UPLOAD_MB: '-1', BACKUP_MAX_EXPANDED_MB: 'invalid' }, async () => {
    assert.deepEqual(getBackupLimits(), { maxUploadBytes: 100 * 1024 ** 2, maxExpandedBytes: 100 * 1024 ** 2 });
  });
});
