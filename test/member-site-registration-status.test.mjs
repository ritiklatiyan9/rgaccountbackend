import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { findSiteRegistrationMatches, getSiteRegistrationStatus } from '../src/services/memberSiteRegistration.service.js';

const user = { id: 7, role: 'admin', organization_id: 1 };
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id INT PRIMARY KEY, name TEXT, organization_id INT);
    INSERT INTO sites VALUES(1,'OM',1),(2,'BALAJI',1),(3,'GANESH',1),(4,'PRIVATE',2);
    CREATE TABLE user_sites(user_id INT, site_id INT);
    INSERT INTO user_sites VALUES(8,1),(8,2);
    CREATE TABLE members(id INT PRIMARY KEY,site_id INT,full_name TEXT,phone TEXT,
      aadhar_no TEXT,pan_no TEXT,shared_profile_id UUID,father_name TEXT,date_of_birth DATE);
    CREATE TABLE kyc_cases(id INT PRIMARY KEY,client_member_id INT,site_id INT,status TEXT,updated_at TIMESTAMPTZ);
    INSERT INTO members(id,site_id,full_name,phone) VALUES
      (1,1,'RAHUL TOMAR','9897659617'),(2,2,'RAHUL TOMAR','+91 98976 59617'),
      (3,3,'RAHUL KUMAR TOMAR','09897659617'),(4,4,'PRIVATE NAME','9897659617'),
      (5,1,'ARUN','6398319877'),(6,3,'ARUN','6398319877');
    INSERT INTO kyc_cases VALUES(10,1,1,'VERIFIED',now()-interval '1 day'),(11,1,1,'PENDING',now()),
      (12,2,2,'OCR_DONE',now()),(13,3,3,'VERIFIED',now()),(14,5,1,'PENDING',now());`);
  return db;
}

test('preview shows actual KYC per site, prefers verification over newer pending cases and is read-only', async (t) => {
  const db = await fixture(t);
  const before = (await db.query('SELECT * FROM members ORDER BY id')).rows;
  const beforeKyc = (await db.query('SELECT * FROM kyc_cases ORDER BY id')).rows;
  const result = await getSiteRegistrationStatus(db, { memberIds: [1], user });
  assert.equal(result.members[0].kyc_status, 'VERIFIED');
  const bySite = new Map(result.sites.map((site) => [site.site_id, site]));
  assert.equal(bySite.get(1).registrations[0].member_id, 1);
  assert.equal(bySite.get(2).registrations[0].kyc_status, 'OCR_DONE');
  assert.equal(bySite.get(2).verified_count, 0);
  assert.equal(bySite.get(3).registrations[0].different_name, true);
  assert.equal(bySite.get(3).registrations[0].full_name, 'RAHUL KUMAR TOMAR');
  assert.equal(bySite.get(3).verified_count, 1);
  assert.equal(bySite.has(4), false);
  assert.deepEqual((await db.query('SELECT * FROM members ORDER BY id')).rows, before);
  assert.deepEqual((await db.query('SELECT * FROM kyc_cases ORDER BY id')).rows, beforeKyc);
  assert.ok(!JSON.stringify(result).includes('9897659617'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE NAME'));
});

test('bulk preview distinguishes missing, registered and verified users instead of applying source KYC to everyone', async (t) => {
  const db = await fixture(t);
  const result = await getSiteRegistrationStatus(db, { memberIds: [1, 5], user });
  const balaji = result.sites.find((site) => site.site_id === 2);
  assert.equal(balaji.registered_count, 1);
  assert.equal(balaji.missing_count, 1);
  assert.equal(balaji.verified_count, 0);
  assert.equal(balaji.registrations.find((entry) => entry.source_member_id === 5).registered, false);
  const ganesh = result.sites.find((site) => site.site_id === 3);
  assert.equal(ganesh.registered_count, 2);
  assert.equal(ganesh.verified_count, 1);
  assert.equal(ganesh.registrations.find((entry) => entry.source_member_id === 5).kyc_status, null);
});

test('linked identities are found even when the saved names and contacts differ', async (t) => {
  const db = await fixture(t);
  await db.query("UPDATE members SET shared_profile_id='12345678-1234-1234-1234-123456789012' WHERE id IN (1,2)");
  await db.query("UPDATE members SET full_name='OLD NAME',phone='9000000000' WHERE id=2");
  const result = await getSiteRegistrationStatus(db, { memberIds: [1], user });
  assert.equal(result.sites.find((site) => site.site_id === 2).registrations[0].member_id, 2);
});

test('invalid legacy phone text cannot match unrelated empty contacts and exact name fallback still works', async (t) => {
  const db = await fixture(t);
  await db.exec("INSERT INTO members(id,site_id,full_name,phone) VALUES (20,1,'FIRM','Contact unavailable'),(21,2,'UNRELATED','No phone'),(22,3,'FIRM',NULL)");
  const result = await getSiteRegistrationStatus(db, { memberIds: [20], user });
  assert.equal(result.sites.find((site) => site.site_id === 2).missing_count, 1);
  assert.equal(result.sites.find((site) => site.site_id === 3).registered_count, 1);
});

test('government IDs find existing registrations without a phone and duplicates are reported consistently', async (t) => {
  const db = await fixture(t);
  await db.exec("INSERT INTO members(id,site_id,full_name,aadhar_no) VALUES (20,1,'TEST','1234 5678 9012'),(21,2,'TEST','123456789012'),(22,2,'TEST','123456789012')");
  const preview = await getSiteRegistrationStatus(db, { memberIds: [20], user });
  const registration = preview.sites.find((site) => site.site_id === 2).registrations[0];
  assert.equal(registration.registration_count, 2);
  await db.query('BEGIN');
  const matches = await findSiteRegistrationMatches(db, { memberIds: [20], siteIds: [2], lock: true });
  await db.query('ROLLBACK');
  assert.equal(matches[0].id, registration.member_id);
});

test('shared PAN and Aadhaar placeholder text does not mark unrelated users as registered', async (t) => {
  const db=await fixture(t);
  await db.exec("INSERT INTO members(id,site_id,full_name,pan_no,aadhar_no) VALUES (20,1,'TEST','NOT AVAILABLE','000000000000'),(21,2,'UNRELATED','NOT AVAILABLE','000000000000')");
  const result=await getSiteRegistrationStatus(db,{memberIds:[20],user});
  assert.equal(result.sites.find(site=>site.site_id===2).missing_count,1);
});

test('preview limits assigned sites and rejects inaccessible or missing source members', async (t) => {
  const db = await fixture(t);
  const subAdmin = { ...user, id: 8, role: 'sub_admin' };
  const result = await getSiteRegistrationStatus(db, { memberIds: [1], user: subAdmin });
  assert.deepEqual(result.sites.map((site) => site.site_id).sort(), [1, 2]);
  await assert.rejects(getSiteRegistrationStatus(db, { memberIds: [3], user: subAdmin }), { statusCode: 403 });
  await assert.rejects(getSiteRegistrationStatus(db, { memberIds: [4], user }), { statusCode: 403 });
  await assert.rejects(getSiteRegistrationStatus(db, { memberIds: [999], user }), { statusCode: 404 });
});
