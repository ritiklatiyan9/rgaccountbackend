import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import pool from '../src/config/db.js';
import { getMemberAgreementPortrait } from '../src/controllers/member.controller.js';
import { portraitJpeg, portraitStorage } from '../src/services/memberAgreementPortrait.js';

const config = { CLOUDINARY_CLOUD_NAME: 'example', AWS_S3_BUCKET_NAME: 'members', AWS_REGION: 'ap-south-1' };

test('portrait reads verify site and registration before loading any bytes', async t => {
  const queries = [];
  const query = t.mock.method(pool, 'query', async (sql, params) => {
    queries.push([sql, params]);
    return { rows: [] };
  });
  function request() {
    return new Promise((resolve, reject) => {
      const response = {
        code: 200, headers: {}, set(key, value) { this.headers[key] = value; },
        status(code) { this.code = code; return this; }, json(body) { resolve({ code:this.code, headers:this.headers, body }); },
      };
      getMemberAgreementPortrait({ user: { id:6, organization_id:8, role:'sub_admin' }, params:{ id:'25' }, query:{ site_id:'7' } }, response, reject);
    });
  }
  assert.equal((await request()).code, 403);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0][1], [7, 8, 6]);
  query.mock.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM sites')) return { rows: [{ id:7 }] };
    assert.match(sql, /WHERE id = \$1 AND site_id = \$2/);
    assert.deepEqual(params, [25,7]);
    return { rows: [{ photo:null }] };
  });
  const allowed = await request();
  assert.deepEqual(allowed.body, { photo:'' });
  assert.equal(allowed.headers['Cache-Control'], 'private, no-store');
});

test('member photos come from the configured upload stores or local KYC directory', () => {
  assert.equal(portraitStorage('https://res.cloudinary.com/example/image/upload/v1/uploads/person.webp', config).kind, 'cloudinary');
  assert.equal(portraitStorage('https://members.s3.ap-south-1.amazonaws.com/kyc_documents/person.jpg', config).kind, 's3');
  assert.equal(portraitStorage('/uploads/kyc_documents/123-photo.jpg', config).filename, '123-photo.jpg');
  for (const url of ['https://example.invalid/image.jpg', 'https://res.cloudinary.com/other/image/upload/photo.jpg',
    'https://res.cloudinary.com/example/raw/upload/id.pdf', '/uploads/kyc_documents/../secrets.txt',
    'https://other.s3.ap-south-1.amazonaws.com/profile.jpg']) assert.equal(portraitStorage(url, config), null);
});

test('the print portrait decodes a supported raster, strips metadata and preserves aspect ratio', async () => {
  const source = await sharp({ create: { width: 1000, height: 400, channels: 3, background: '#113355' } })
    .withMetadata({ density: 144 }).webp().toBuffer();
  const meta = await sharp(await portraitJpeg(source)).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.deepEqual([meta.width, meta.height], [640, 256]);
  assert.equal(meta.exif, undefined);
  await assert.rejects(portraitJpeg(Buffer.from('<svg width="1" height="1"></svg>')));
  await assert.rejects(portraitJpeg(Buffer.alloc(0)));
});
