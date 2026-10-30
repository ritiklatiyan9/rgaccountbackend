import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { signApprovalVoucherLinks } from '../src/services/approvalVoucherLinks.service.js';
import { signExpenseDocuments } from '../src/utils/expenseDocumentUrls.js';

test('approval vouchers are signed only for accessible sites and retain their record identity', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id integer PRIMARY KEY, organization_id integer);
    CREATE TABLE user_sites(user_id integer, site_id integer);
    INSERT INTO sites VALUES(1,1),(2,1),(3,2);
    INSERT INTO user_sites VALUES(7,1),(7,3);`);
  const items = [1, 2, 3].map(site_id => ({ id: site_id, site_id, voucher_url: `https://files.test/vouchers/${site_id}.jpg` }));
  const sign = row => signExpenseDocuments(row, async url => `${url}?fresh=1`);
  const sub = await signApprovalVoucherLinks(items, { id: 7, role: 'sub_admin', organization_id: 1 }, db, sign);
  assert.deepEqual(sub.map(row => row.voucher_url), [items[0].voucher_url + '?fresh=1', items[1].voucher_url, items[2].voucher_url]);
  assert.deepEqual(sub.map(row => row.id), [1, 2, 3]);
  assert.equal(items[0].voucher_url, 'https://files.test/vouchers/1.jpg');
  const admin = await signApprovalVoucherLinks(items, { id: 8, role: 'admin', organization_id: 1 }, db, sign);
  assert.deepEqual(admin.map(row => row.voucher_url.endsWith('?fresh=1')), [true, true, false]);
  const superAdmin = await signApprovalVoucherLinks(items, { id: 9, role: 'super_admin', organization_id: 1 }, db, sign);
  assert.deepEqual(superAdmin.map(row => row.voucher_url.endsWith('?fresh=1')), [true, true, true]);
});

test('approval response replaces expired signatures for configured private voucher storage', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id integer PRIMARY KEY, organization_id integer);
    CREATE TABLE user_sites(user_id integer, site_id integer);
    INSERT INTO sites VALUES(1,1); INSERT INTO user_sites VALUES(7,1);`);
  const keys = ['AWS_S3_BUCKET_NAME', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; });
  Object.assign(process.env, { AWS_S3_BUCKET_NAME: 'private-approval-test', AWS_REGION: 'ap-south-1', AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret' });
  const url = 'https://private-approval-test.s3.ap-south-1.amazonaws.com/vouchers/receipt.jpg?X-Amz-Signature=expired';
  const [entry] = await signApprovalVoucherLinks([{ site_id: 1, voucher_url: url }], { id: 7, role: 'sub_admin', organization_id: 1 }, db);
  assert.match(entry.voucher_url, /X-Amz-Signature=/);
  assert.match(entry.voucher_url, /X-Amz-Expires=3600/);
  assert.doesNotMatch(entry.voucher_url, /expired/);
});
