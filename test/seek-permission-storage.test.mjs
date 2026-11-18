import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { storeSeekFiles, isOwnSeekAttachment } from '../src/services/seekPermission.service.js';
import { sendRequestAttachment } from '../src/utils/requestAttachmentContent.js';

test('new Seek photos and PDFs use existing voucher storage and retain attachment metadata', async () => {
  const env = { AWS_S3_BUCKET_NAME: 'test-storage', AWS_REGION: 'us-east-1' };
  const files = [
    { path: '/tmp/photo-upload', filename: 'unique-photo.jpeg', originalname: 'Bill photo.jpeg', mimetype: 'image/jpeg', size: 215925 },
    { path: '/tmp/pdf-upload', filename: 'unique-bill.pdf', originalname: 'Quotation.pdf', mimetype: 'application/pdf', size: 1234 },
  ];
  const stored = await storeSeekFiles(files, async (_path, name, _type, folder) => {
    assert.equal(folder, 'vouchers');
    return `https://test-storage.s3.us-east-1.amazonaws.com/${folder}/${name}`;
  });
  assert.deepEqual(stored.map(file => file.name), ['Bill photo.jpeg', 'Quotation.pdf']);
  assert.deepEqual(stored.map(file => file.type), ['image/jpeg', 'application/pdf']);
  assert.deepEqual(stored.map(file => file.size), [215925,1234]);
  assert.ok(stored.every(file => isOwnSeekAttachment(file.url,env)));
  assert.ok(stored.every(file => !file.url.includes('/seek-permissions/')));
  assert.equal(isOwnSeekAttachment('https://test-storage.s3.us-east-1.amazonaws.com/seek-permissions/older.jpeg',env),true);
  for(const url of [
    'https://test-storage.s3.us-east-1.amazonaws.com/kyc_documents/private.pdf',
    'https://test-storage.s3.us-east-1.amazonaws.com/vouchers-other/private.pdf',
    'https://other-storage.s3.us-east-1.amazonaws.com/vouchers/private.pdf',
    'https://test-storage.s3.us-east-1.amazonaws.com.evil.test/vouchers/private.pdf',
  ]) assert.equal(isOwnSeekAttachment(url,env),false);
});

test('private previews stream original bytes with the right MIME, even for legacy metadata', async () => {
  const env = { AWS_S3_BUCKET_NAME: 'current-test', LEGACY_AWS_S3_BUCKET_NAME: 'older-test' };
  for (const [fileName, type] of [['proof.PDF', 'application/pdf'], ['photo.jpeg', 'image/jpeg']]) {
    const contents = Buffer.from('test attachment');
    const chunks = [];
    const headers = {};
    const response = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
    response.set = (field, value) => typeof field === 'string' ? headers[field] = value : Object.assign(headers, field);
    const file = { url: `https://older-test.s3.ap-south-1.amazonaws.com/seek-permissions/${fileName}`, name: 'Evidence' };
    await sendRequestAttachment(response, file, { env, read: async (storage, signal) => {
      assert.equal(storage.profile, 'legacy');
      assert.equal(storage.Key, `seek-permissions/${fileName}`);
      assert.equal(signal.aborted, false);
      return { Body: Readable.from([contents]), ContentLength: contents.length, ContentType: 'application/octet-stream' };
    } });
    assert.equal(headers['Content-Type'], type);
    assert.equal(headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(Buffer.concat(chunks), contents);
  }
  await assert.rejects(sendRequestAttachment(null, { url: 'https://current-test.s3.ap-south-1.amazonaws.com/kyc/private.pdf' }, { env }), { statusCode: 404 });
});
