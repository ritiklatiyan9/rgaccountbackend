import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { applyVerifiedKycAddresses, loadClientMapAddresses, MAP_KYC_ADDRESSES_SQL } from '../src/services/clientMapAddresses.service.js';
import { buildClientMap } from '../src/services/clientMapAnalytics.service.js';
import { lookupIndianLocation } from '../src/services/indiaLocationReference.js';
import { addressParts, cacheKey } from '../src/services/clientLocation.js';
import { addressTextForAi, locateAddressWithAi, validateAiLocality } from '../src/services/clientAddressAi.service.js';
import { geocodeAddress, geocodePendingMembers } from '../src/services/geocode.service.js';

const document = (id, memberId, address, extra = {}) => ({ id, member_id: memberId, case_id: 5, type: 'AADHAAR',
  member_document_field: 'aadhar_back_url', ocr_status: 'DONE',
  extracted_fields: { address }, confidence_map: { address: 0.99 },
  raw_text: { text: `Address: ${address}`, evidence: { address: `Address: ${address}` } }, ...extra });

test('uses the latest evidenced KYC address, preserves a profile address, and returns no OCR or identity data', () => {
  const rows = applyVerifiedKycAddresses([{ id: 1 }, { id: 2, address: 'Delhi', city: 'Delhi' }, { id: 3 }], [
    document(1, 1, 'Old address'), document(2, 1, 'Meerut, Uttar Pradesh 250001'),
    document(3, 2, 'Meerut, Uttar Pradesh'), document(4, 3, 'Delhi', { raw_text: { text: 'Delhi' } }),
  ]);
  assert.equal(rows[0].address_source, 'kyc'); assert.equal(rows[0].address, 'Meerut, Uttar Pradesh 250001');
  assert.equal(rows[1].address_source, 'profile'); assert.equal(rows[1].address, 'Delhi');
  assert.equal(rows[2].address, ''); assert.equal(rows[2].kyc_address_needs_review, true);
  assert.equal(rows[0].raw_text, undefined); assert.equal(rows[0].extracted_fields, undefined);
  const map = buildClientMap(rows);
  assert.equal(map.summary.geocoded, 2); assert.equal(map.summary.from_kyc, 1);
  assert.equal(map.members[0].precision, 'pincode'); assert.equal(map.members[0].location_status, 'approximate');
});

test('conflicting active documents and unfinished replacement OCR require review', () => {
  const conflict = applyVerifiedKycAddresses([{ id: 1 }], [document(1, 1, 'Meerut'), document(2, 1, 'Delhi', { type: 'PASSPORT', member_document_field: 'passport_url' })]);
  assert.equal(conflict[0].address, ''); assert.equal(conflict[0].kyc_address_needs_review, true);
  const retry = applyVerifiedKycAddresses([{ id: 1 }], [document(1, 1, 'Meerut'), document(2, 1, 'Delhi', { ocr_status: 'PROCESSING' })]);
  assert.equal(retry[0].address, '');
});

test('resolves PIN areas, full addresses and permanent addresses locally, preserving manual pins and financial totals', async () => {
  const noNetwork = { query: async () => ({ rows: [] }) };
  const rows = await loadClientMapAddresses([
    { id: 1, address: 'Meerut, Uttar Pradesh 250001', total_paid: '12.34' },
    { id: 2, permanent_address: 'Meerut, Uttar Pradesh' },
    { id: 3, address: 'Meerut', lat: 28, lng: 77, source: 'manual' },
  ], { db: noNetwork, siteId: 10 });
  const map = buildClientMap(rows);
  assert.equal(map.summary.geocoded, 3); assert.equal(map.summary.manual, 1);
  assert.equal(map.members[0].source, 'geonames'); assert.equal(map.members[0].total_paid, 12.34);
  assert.equal(map.members[1].address_source, 'permanent');
  assert.equal(map.members[2].lat, 28); assert.equal(map.members[2].lng, 77);
  const point = await geocodeAddress({ city: 'Meerut' }, { db: { query: () => { throw new Error('No DB needed'); } }, fetchImpl: () => { throw new Error('No network needed'); } });
  assert.equal(point.precision, 'city'); assert.equal(point.source, 'geonames');
});

test('rejects ambiguous towns and mismatching postal regions, and ignores a city named in a road', () => {
  assert.equal(lookupIndianLocation({ city: 'Rampur' }), null);
  assert.equal(lookupIndianLocation({ pincode: '250001', state: 'Rajasthan' }), null);
  assert.equal(lookupIndianLocation({ city: 'Meerut', state: 'Rajasthan' }), null);
  const parts = addressParts({ address: 'Meerut Road, Delhi' });
  assert.equal(parts.city, 'DELHI');
  assert.equal(buildClientMap([{ id: 1, address: 'House 25' }]).summary.geocoded, 0);
  assert.equal(buildClientMap([{ id: 1, city: 'Meerut', source: 'manual', lat: null, lng: 77 }]).summary.geocoded, 0);
});

const aiPayload = { fields: { city: 'Meerut', state: 'Uttar Pradesh' }, evidence: { city: 'Meerutt', state: 'Uttar Pradesh' }, confidence: { city: 0.99, state: 0.99 } };
const typoAddress = { address: 'Market, Meerutt, Uttar Pradesh' };
test('AI repairs evidenced spelling only and gets coordinates from the public reference', () => {
  const point = validateAiLocality(aiPayload, typoAddress);
  assert.equal(point.source, 'ai_geonames'); assert.equal(point.locality.city, 'Meerut');
  assert.equal(validateAiLocality({ ...aiPayload, evidence: { city: 'Mumbai' } }, typoAddress), null);
  assert.equal(validateAiLocality({ ...aiPayload, fields: { city: 'Mumbai' } }, typoAddress), null);
  assert.equal(validateAiLocality({ ...aiPayload, confidence: { city: 0.8 } }, typoAddress), null);
  assert.equal(validateAiLocality({ fields: { pincode: '250001' }, evidence: { pincode: '250001' }, confidence: { pincode: 0.99 } }, { address: 'Meerut' }), null);
});

test('AI gets only address fields; removed relatives, IDs and contact details are never submitted', async () => {
  const member = { ...typoAddress, name: 'Private Name', phone: '9876543210', aadhar_no: '234567891234',
    address: 'C/O Private Relative, House 25, Market, Meerutt, Uttar Pradesh, 9876543210' };
  assert.doesNotMatch(addressTextForAi(member), /Private|9876543210|House 25/);
  let called = false;
  const point = await locateAddressWithAi(member, { complete: async request => {
    called = true; assert.doesNotMatch(JSON.stringify(request.userContent), /Private|9876543210|234567891234/);
    return { json: aiPayload, error: null };
  } });
  assert.equal(called, true); assert.equal(point.source, 'ai_geonames');
});

test('AI cache is address-specific, does not store the address, and an outage is never negative-cached', async () => {
  const queries = [];
  const db = { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [] }; } };
  const point = validateAiLocality(aiPayload, typoAddress);
  await geocodeAddress(typoAddress, { db, useAI: true, aiLookup: async () => point });
  assert.equal(queries.length, 2); assert.doesNotMatch(queries[1].args[0], /Market|Meerutt/i);
  assert.equal(JSON.parse(queries[1].args[4]).locality.city, 'Meerut');
  assert.notEqual(cacheKey(typoAddress), cacheKey({ address: 'Other area, Meerutt, Uttar Pradesh' }));
  queries.length = 0;
  await assert.rejects(geocodeAddress(typoAddress, { db, useAI: true, aiLookup: async () => { throw new Error('outage'); } }), /outage/);
  assert.equal(queries.length, 1);
});

test('AI batch checks an address-only member and caches its location without overwriting their profile', async () => {
  const statements = [];
  const rows = [{ id: 2, ...typoAddress }];
  const client = { query: async (sql, args) => { statements.push({ sql, args }); return sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : sql.includes('SELECT id, address') ? { rows } : { rows: [], rowCount: 1 }; }, release() {} };
  const result = await geocodePendingMembers({ siteId: 10, useAI: true }, { db: { connect: async () => client }, loadAddresses: async rows => rows, lookup: async () => validateAiLocality(aiPayload, typoAddress) });
  assert.equal(result.geocoded, 1); assert.equal(result.has_more, false);
  assert.equal(statements.some(statement => statement.sql.startsWith('UPDATE members')), false);
});

test('KYC fallback SQL rejects other sites, unverified cases, old cases and mismatched documents', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE members(id int,site_id int);
      CREATE TABLE kyc_cases(id int,client_member_id int,site_id int,status text,verified_at timestamptz);
      CREATE TABLE documents(id int,kyc_case_id int,client_member_id int,site_id int,type text,member_document_field text,ocr_status text);
      CREATE TABLE ocr_results(id int,document_id int,extracted_fields jsonb,confidence_map jsonb,raw_text jsonb);
      INSERT INTO members VALUES(1,10),(2,20),(3,10);
      INSERT INTO kyc_cases VALUES(1,1,10,'VERIFIED','2025-01-01'),(2,1,10,'VERIFIED','2026-01-01'),(3,2,20,'VERIFIED','2026-01-01'),(4,3,10,'OPEN',null);
      INSERT INTO documents VALUES(1,1,1,10,'AADHAAR','aadhar_back_url','DONE'),(2,2,1,10,'AADHAAR','aadhar_back_url','DONE'),(3,3,2,20,'AADHAAR','aadhar_back_url','DONE'),(4,4,3,10,'AADHAAR','aadhar_back_url','DONE'),(5,2,2,20,'AADHAAR','aadhar_back_url','DONE');`);
    const result = await db.query(MAP_KYC_ADDRESSES_SQL, [10, [1, 2, 3]]);
    assert.deepEqual(result.rows.map(row => [row.member_id, row.id]), [[1, 2]]);
  } finally { await db.close(); }
});
