import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDriveDocumentLinks, resolveDriveDocumentLink, driveDocumentStorage } from '../src/services/driveDocumentLinks.service.js';

process.env.CALENDAR_TOKEN_ENC_KEY = 'c'.repeat(64);
const env = { AWS_S3_BUCKET_NAME: 'accounting-test-bucket', AWS_REGION: 'ap-south-1', AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret',
  PUBLIC_API_URL: 'https://api.example.test/api', NODE_ENV: 'production' };
const document = { id: 'document:31', name: 'Agreement.pdf', url: 'documents/site-2/agreement.pdf', sourceModule: 'plot_commission', sourceId: 31 };
const fixture = () => {
  const state = { connected: true, siteValid: true, grants: [{ id: 9, site_id: 2, role: 'reader', drive_permission_id: 'permission-9', created_at: '2026-01-01' }], calls: [] };
  const db = { query: async (sql, values) => {
    state.calls.push({ sql, values });
    assert.deepEqual(values, [1, 2]);
    if (sql.includes('FROM google_drive_connections')) {
      assert.match(sql, /s\.organization_id=\$1/);
      return { rows: state.connected && state.siteValid ? [{ id: 7, google_account_email: 'owner@example.test', root_folder_id: 'root-folder' }] : [] };
    }
    assert.match(sql, /organization_id=\$1 AND \(site_id=\$2 OR site_id IS NULL\)/);
    return { rows: state.grants };
  } };
  return { state, db };
};
const tokenOf = (prepared) => new URL(prepared.url).pathname.split('/').at(-1);

test('durable links are scoped opaque capabilities that sign a fresh S3 URL on open', async () => {
  const { state, db } = fixture();
  const [prepared] = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env });
  assert.match(prepared.url, /^https:\/\/api\.example\.test\/api\/public\/drive-documents\/[A-Za-z0-9_-]+$/);
  assert.equal(prepared.url.includes('agreement.pdf'), false);
  assert.equal(prepared.url.includes('X-Amz'), false);
  let signed = 0;
  const sign = async (object) => {
    signed += 1;
    assert.equal(object.Bucket, env.AWS_S3_BUCKET_NAME);
    assert.equal(object.Key, document.url);
    return `https://fresh.example.test/${signed}`;
  };
  assert.equal(await resolveDriveDocumentLink(tokenOf(prepared), { db, env, sign }), 'https://fresh.example.test/1');
  assert.equal(await resolveDriveDocumentLink(tokenOf(prepared), { db, env, sign }), 'https://fresh.example.test/2');
  assert.equal(state.calls.length, 6, 'every open rechecks current scope and CA grants');
});

test('tampering is rejected before database reads or S3 signing', async () => {
  const { state, db } = fixture();
  const [prepared] = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env });
  const packed = Buffer.from(tokenOf(prepared), 'base64url');
  packed[packed.length - 5] ^= 1;
  state.calls.length = 0;
  await assert.rejects(resolveDriveDocumentLink(packed.toString('base64url'), { db, env, sign: () => assert.fail('must never sign') }), { code: 'DRIVE_DOCUMENT_LINK_INVALID' });
  assert.equal(state.calls.length, 0);
});

test('removing CA access, changing a role, disconnecting, and moving site scope all revoke prior links', async () => {
  for (const mutation of [
    (state) => { state.grants = []; },
    (state) => { state.grants[0].role = 'writer'; },
    (state) => { state.connected = false; },
    (state) => { state.siteValid = false; },
  ]) {
    const { state, db } = fixture();
    const [prepared] = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env });
    mutation(state);
    await assert.rejects(resolveDriveDocumentLink(tokenOf(prepared), { db, env, sign: () => assert.fail('revoked access must not sign') }), { code: 'DRIVE_DOCUMENT_LINK_REVOKED' });
  }
});

test('same storage object keeps its content identity despite changing presigned URL parameters', async () => {
  const { db } = fixture();
  const url = `https://${env.AWS_S3_BUCKET_NAME}.s3.ap-south-1.amazonaws.com/documents/agreement.pdf`;
  const first = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [{ ...document, url: `${url}?X-Amz-Signature=one` }] }, { db, env });
  const second = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [{ ...document, url: `${url}?X-Amz-Signature=two&X-Amz-Expires=3600` }] }, { db, env });
  assert.equal(first[0].sourceFingerprint, second[0].sourceFingerprint);
  assert.equal(first[0].linkVersion, second[0].linkVersion);
  assert.notEqual(first[0].url, second[0].url, 'randomized encryption does not expose a stable object identifier');
});

test('moving the public document endpoint refreshes Excel links without changing storage identity', async () => {
  const { db } = fixture();
  const [first] = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env });
  const [moved] = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env: { ...env, PUBLIC_API_URL: 'https://new-api.example.test/api' } });
  assert.equal(first.sourceFingerprint, moved.sourceFingerprint);
  assert.notEqual(first.linkVersion, moved.linkVersion);
  assert.match(moved.url, /^https:\/\/new-api\.example\.test\/api\/public\/drive-documents\//);
  assert.equal(await resolveDriveDocumentLink(tokenOf(moved), { db, env, sign: async () => 'fresh-url' }), 'fresh-url');
});

test('arbitrary hosts, foreign buckets, local files and traversal are never signed', async () => {
  const { db } = fixture();
  const invalid = ['https://169.254.169.254/latest/meta-data', 'https://evil.example/document',
    'https://foreign-bucket.s3.ap-south-1.amazonaws.com/file.pdf', 'local::private.pdf', '../secrets.txt', 'https://accounting-test-bucket.s3.ap-south-1.amazonaws.com/%2e%2e/private.pdf', 'file:///etc/passwd'];
  for (const url of invalid) assert.equal(driveDocumentStorage(url, env), null, url);
  const result = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: invalid.map((url, id) => ({ ...document, id, url })) }, { db, env });
  assert.ok(result.every((item) => item.url === null && item.unavailable));
});

test('preview remains available without a connected Drive or configured CA recipient', async () => {
  const { state, db } = fixture();
  state.connected = false;
  const disconnected = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env: { ...env, PUBLIC_API_URL: undefined } });
  assert.equal(disconnected[0].url, null);
  assert.match(disconnected[0].unavailable, /Connect Google Drive/);
  state.connected = true;
  state.grants = [];
  const unshared = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env });
  assert.match(unshared[0].unavailable, /Add CA access/);
});

test('invalid numeric scopes and unavailable configured storage fail closed', async () => {
  await assert.rejects(prepareDriveDocumentLinks({ orgId: 1, siteId: 'oops', documents: [document] }, { db: { query: () => assert.fail('invalid scope must not query') }, env }), { statusCode: 400 });
  const { db } = fixture();
  const [prepared] = await prepareDriveDocumentLinks({ orgId: 1, siteId: 2, documents: [document] }, { db, env });
  await assert.rejects(resolveDriveDocumentLink(tokenOf(prepared), { db, env: { ...env, AWS_S3_BUCKET_NAME: 'different-bucket' }, sign: () => assert.fail('unknown bucket must not sign') }), { code: 'DRIVE_DOCUMENT_LINK_REVOKED' });
});
