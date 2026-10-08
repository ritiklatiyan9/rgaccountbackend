import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readPendingMemberKycCases } from '../src/services/pendingMemberKyc.service.js';

test('pending KYC follows current Clients records, excludes stale/deleted cases, and reports saved profile documents', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, email TEXT);
      CREATE TABLE members(id INTEGER PRIMARY KEY, site_id INTEGER, full_name TEXT, phone TEXT, email TEXT,
        address TEXT, city TEXT, aadhar_no TEXT, pan_no TEXT, voter_id TEXT, passport_no TEXT, driving_license_no TEXT,
        aadhar_front_url TEXT, aadhar_back_url TEXT, pan_card_url TEXT, voter_id_url TEXT,
        passport_url TEXT, driving_license_url TEXT, cheque_url TEXT, other_kyc_url TEXT,
        created_by INTEGER DEFAULT 1, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE kyc_cases(id INTEGER PRIMARY KEY, site_id INTEGER, client_member_id INTEGER, booking_id INTEGER,
        mode TEXT DEFAULT 'MANUAL_OCR', status TEXT, created_by INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE documents(id INTEGER PRIMARY KEY, kyc_case_id INTEGER, ocr_status TEXT);
      INSERT INTO sites VALUES (1,'Current site'),(2,'Other site');
      INSERT INTO users VALUES (1,'Profile creator','creator@example.com');
      INSERT INTO members(id,site_id,full_name,phone,address,aadhar_no,aadhar_front_url) VALUES
        (1,1,'Missing profile','9000000001',NULL,NULL,NULL),
        (2,1,'Profile with document','9000000002','Address',NULL,'https://example.com/front.pdf'),
        (3,1,'Complete profile','9000000003','Address','1234','https://example.com/front.pdf'),
        (4,1,'Processing client','9000000004','Address','1234','https://example.com/front.pdf'),
        (5,1,'Already verified','9000000005','Address','1234','https://example.com/front.pdf'),
        (7,2,'Wrong site member','9000000007','Address','1234','https://example.com/front.pdf'),
        (8,1,'Rejected incomplete profile',NULL,NULL,NULL,NULL),
        (9,1,'Ready for review','9000000009','Address','1234','https://example.com/front.pdf'),
        (10,1,'Started case','9000000010',NULL,NULL,NULL),
        (11,2,'Other site case','9000000011','Address','1234','https://example.com/front.pdf');
      INSERT INTO kyc_cases(id,site_id,client_member_id,status,booking_id) VALUES
        (4,1,4,'OCR_PENDING',NULL), (5,1,5,'OPEN',NULL), (6,1,5,'VERIFIED',NULL),
        (7,1,8,'REJECTED',NULL), (8,1,NULL,'OCR_DONE',NULL), (9,1,999,'OPEN',NULL),
        (10,1,7,'OPEN',NULL), (11,1,9,'OCR_DONE',NULL), (12,1,10,'OPEN',NULL),
        (13,2,11,'OPEN',NULL), (14,1,4,'OPEN',123);
      INSERT INTO documents VALUES (1,4,'DONE'),(2,4,'PROCESSING'),(3,11,'DONE'),(4,11,'DONE'),(5,8,'DONE');`);
    const result = await readPendingMemberKycCases(db, 1);
    assert.equal(result.total, 7);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.cases.map(row => Number(row.id)).sort((a,b) => a-b), [-8,-2,-1,4,11,12,14]);
    assert.ok(result.cases.every(row => row.client_member_id && row.client_name));
    const profile = result.cases.find(row => Number(row.id) === -2);
    assert.equal(profile.document_count, 1);
    assert.equal(profile.completed_documents, 0, 'saved profile files are not automatically OCR-verified');
    assert.equal(profile.created_by_name, 'Profile creator');
    assert.deepEqual(profile.missing_fields, ['identity']);
    const processing = result.cases.find(row => Number(row.id) === 4);
    assert.equal(processing.document_count, 2);
    assert.equal(processing.completed_documents, 1);
    assert.equal(processing.processing_documents, 1);
    assert.equal(result.cases.find(row => Number(row.id) === 14).booking_id, 123);
    const limited = await readPendingMemberKycCases(db, 1, 2);
    assert.equal(limited.total, 7);
    assert.equal(limited.cases.length, 2);
    assert.equal(limited.truncated, true);
    assert.deepEqual((await readPendingMemberKycCases(db, 2)).cases.map(row => Number(row.id)), [13]);
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM kyc_cases')).rows[0].count, 11);
    assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM documents')).rows[0].count, 5);
  } finally {
    await db.close();
  }
});
