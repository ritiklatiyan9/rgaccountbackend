import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  attachmentReferences, captureAttachments, validateAttachments, restoreAttachments,
} from '../src/services/backupAttachments.js';

const env = { AWS_S3_BUCKET_NAME: 'account-test', AWS_REGION: 'ap-south-1' };
const data = Buffer.from('a document with unicode: हिंदी');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const entry = (changes = {}) => ({ storage: 'local', key: 'kyc_documents/proof.pdf', data: data.toString('base64'), sha256: hash(data), ...changes });
const archive = (files = [entry()]) => ({ version: 1, files, external: [] });
async function temporary(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'account-backup-test-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('discovers module files, nested JSON, PG URL arrays and explicitly configured legacy S3 objects once', () => {
  const tables = [
    { name: 'documents', columns: ['file_path', 'metadata'], rows: [['local::proof.pdf', JSON.stringify({ preview: 'https://account-test.s3.ap-south-1.amazonaws.com/vouchers/a%20b.pdf' })]] },
    { name: 'excel_files', columns: ['s3_key'], rows: [['local::sheet.xlsx']] },
    { name: 'expenses', columns: ['voucher_urls'], rows: [['{"https://account-test.s3.ap-south-1.amazonaws.com/vouchers/a%20b.pdf","https://res.cloudinary.com/example/file.pdf"}']] },
    { name: 'recycle_bin_entries', columns: ['row_data'], rows: [[JSON.stringify({ s3_key: 'local::sheet.xlsx' })]] },
    { name: 'members', columns: ['pan_url'], rows: [['https://legacy-test.s3.us-east-1.amazonaws.com/kyc/a.pdf']] },
  ];
  const refs = attachmentReferences(tables, { env: { ...env, LEGACY_AWS_S3_BUCKET_NAME: 'legacy-test' } });
  assert.deepEqual(refs.files.map((file) => file.key).sort(), ['excel/sheet.xlsx', 'kyc/a.pdf', 'kyc_documents/proof.pdf', 'vouchers/a b.pdf']);
  assert.equal(refs.files.find((file) => file.bucket === 'legacy-test').region, 'us-east-1');
  assert.equal(refs.external.length, 1);
});

test('untrusted hosts stay external and local references cannot traverse paths', () => {
  const tables = [{ name: 'documents', columns: ['file_path'], rows: [
    ['https://account-test.s3.ap-south-1.amazonaws.com.evil.test/file'],
    ['https://evil.test/uploads/kyc_documents/file'], ['http://169.254.169.254/latest/meta-data'],
  ] }];
  const refs = attachmentReferences(tables, { env });
  assert.equal(refs.files.length, 0); assert.equal(refs.external.length, 3);
  assert.throws(() => attachmentReferences([{ name: 'documents', rows: [{ file_path: 'local::../secret' }] }], { env }), /unsafe filename/);
  assert.throws(() => attachmentReferences([{ name: 'documents', rows: [{ file_path: 'kyc_documents/a' }] }], { env: {} }), /bucket is configured/);
  assert.throws(() => attachmentReferences([{ name: 'documents', rows: [{ file_path: 'kyc_documents/a' }] }], { env: { LEGACY_AWS_S3_BUCKET_NAME: 'legacy' } }), /bucket is configured/);
});

test('captures and restores local files byte for byte, then safely reuses identical files', async (t) => {
  const source = await temporary(t); const target = await temporary(t);
  await fs.mkdir(path.join(source, 'uploads', 'kyc_documents'), { recursive: true });
  await fs.writeFile(path.join(source, 'uploads', 'kyc_documents', 'proof.pdf'), data);
  const tables = [{ name: 'documents', columns: ['file_path'], rows: [['local::proof.pdf']] }];
  const result = await captureAttachments(tables, { cwd: source, env: {} });
  assert.equal(result.files.length, 1); assert.equal(result.files[0].sha256, hash(data));
  assert.equal(validateAttachments(result).bytes, data.length);
  assert.equal((await restoreAttachments(result, { cwd: target })).created, 1);
  assert.deepEqual(await fs.readFile(path.join(target, 'uploads', 'kyc_documents', 'proof.pdf')), data);
  assert.equal((await restoreAttachments(result, { cwd: target })).reused, 1);
});

test('refuses missing managed attachments, oversize files and local symlinks', async (t) => {
  const cwd = await temporary(t);
  const tables = [{ name: 'documents', columns: ['file_path'], rows: [['local::proof.pdf']] }];
  await assert.rejects(captureAttachments(tables, { cwd, env: {} }), /Cannot back up referenced attachment/);
  await fs.mkdir(path.join(cwd, 'uploads', 'kyc_documents'), { recursive: true });
  const file = path.join(cwd, 'uploads', 'kyc_documents', 'proof.pdf');
  await fs.writeFile(file, data);
  await assert.rejects(captureAttachments(tables, { cwd, env: {}, maxBytes: 2 }), /size limit/);
  await assert.rejects(captureAttachments(tables, { cwd, env: {}, maxBytes: 0 }), /size limit/);
  await fs.unlink(file); await fs.writeFile(path.join(cwd, 'outside.pdf'), data); await fs.symlink(path.join(cwd, 'outside.pdf'), file);
  await assert.rejects(captureAttachments(tables, { cwd, env: {} }), /Cannot back up referenced attachment/);
  await assert.rejects(restoreAttachments(archive(), { cwd }), /ELOOP/);
});

test('validates every attachment before writes and refuses corruption, traversal, duplicates or destination changes', async (t) => {
  const cwd = await temporary(t);
  const invalidCases = [
    archive([entry({ key: 'kyc_documents/../escape' })]),
    archive([entry({ data: 'bad!!!!' })]),
    archive([entry({ sha256: '0'.repeat(64) })]),
    archive([entry(), entry()]),
    archive([entry({ storage: 's3', bucket: 'unconfigured', key: 'file.pdf', region: 'ap-south-1' })]),
  ];
  for (const invalid of invalidCases) await assert.rejects(restoreAttachments(invalid, { cwd, env }));
  await assert.rejects(fs.access(path.join(cwd, 'uploads')), /ENOENT/);
  assert.throws(() => validateAttachments(archive(), { maxBytes: data.length - 1 }), /size limit/);
});

test('validates multi-megabyte base64 without regex stack overflow and rejects padding aliases', () => {
  const large = Buffer.alloc(2 * 1024 * 1024, 0xab);
  const saved = archive([entry({ data: large.toString('base64'), sha256: hash(large) })]);
  assert.equal(validateAttachments(saved, { maxBytes: large.length }).bytes, large.length);

  // Both strings decode to the same byte, but only Zg== has zero padding bits.
  const canonical = Buffer.from('f');
  assert.deepEqual(Buffer.from('Zh==', 'base64'), canonical);
  assert.throws(() => validateAttachments(archive([entry({ data: 'Zh==', sha256: hash(canonical) })])), /not canonical/);
});

test('existing different local data is not overwritten', async (t) => {
  const cwd = await temporary(t);
  await fs.mkdir(path.join(cwd, 'uploads', 'kyc_documents'), { recursive: true });
  const file = path.join(cwd, 'uploads', 'kyc_documents', 'proof.pdf');
  await fs.writeFile(file, 'other');
  await assert.rejects(restoreAttachments(archive(), { cwd }), /different contents/);
  assert.equal(await fs.readFile(file, 'utf8'), 'other');
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['proof.pdf']);
});

test('S3 capture and restore use configured storage commands, enforce byte limits and conditional creation', async () => {
  const tables = [{ name: 'documents', columns: ['file_path'], rows: [['kyc_documents/proof.pdf']] }];
  const captured = await captureAttachments(tables, { env, s3Send: async (source, command) => {
    assert.equal(source.bucket, env.AWS_S3_BUCKET_NAME); assert.equal(command.constructor.name, 'GetObjectCommand');
    return { Body: Readable.from([data]), ContentLength: data.length, ContentType: 'application/pdf' };
  } });
  const objects = new Map();
  const send = async (_source, command) => {
    const key = command.input.Key;
    if (command.constructor.name === 'GetObjectCommand') {
      if (!objects.has(key)) { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error; }
      return { Body: Readable.from([objects.get(key)]), ContentLength: objects.get(key).length };
    }
    assert.equal(command.input.IfNoneMatch, '*'); objects.set(key, command.input.Body); return {};
  };
  assert.equal((await restoreAttachments(captured, { env, s3Send: send })).created, 1);
  assert.equal((await restoreAttachments(captured, { env, s3Send: send })).reused, 1);
  objects.set('kyc_documents/proof.pdf', Buffer.from('other'));
  await assert.rejects(restoreAttachments(captured, { env, s3Send: send }), /different contents/);
  await assert.rejects(captureAttachments(tables, { env, maxBytes: 1, s3Send: async () => ({ Body: Readable.from([data]) }) }), /size limit/);
});

test('S3 permission errors never cause a blind overwrite', async () => {
  let puts = 0;
  const files = archive([entry({ storage: 's3', key: 'docs/a.pdf', bucket: env.AWS_S3_BUCKET_NAME, region: env.AWS_REGION })]);
  await assert.rejects(restoreAttachments(files, { env, s3Send: async (_source, command) => {
    if (command.constructor.name === 'PutObjectCommand') puts++;
    const error = new Error('AccessDenied'); error.name = 'AccessDenied'; throw error;
  } }), /AccessDenied/);
  assert.equal(puts, 0);
});
