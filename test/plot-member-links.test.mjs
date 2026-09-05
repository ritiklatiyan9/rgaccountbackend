import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupMemberPlotNumbers, findMemberPlotNumbers, groupMemberPlots, validatePlotBuyerMember,
  PLOT_BUYER_MEMBER_JOIN, PLOT_BUYER_KYC_JOIN, PLOT_BUYER_KYC_STATUS,
} from '../src/services/plotMemberLinks.service.js';

test('members receive all buyer and broker plots, deduplicated and naturally sorted', () => {
  const grouped = groupMemberPlotNumbers([
    { plot_no: 'A10', buyer_member_id: 1, broker_member_ids: [2, 1] },
    { plot_no: 'A2', buyer_member_id: 1, broker_member_ids: [2, 3] },
    { plot_no: 'A2', buyer_member_id: 1, broker_member_ids: [2] },
    { plot_no: ' B1 ', buyer_member_id: null, broker_member_ids: [3] },
    { plot_no: '', buyer_member_id: 1 },
    { plot_no: 'C1', buyer_member_id: null, broker_member_ids: [null] },
  ]);
  assert.deepEqual([...grouped], [['1', ['A2', 'A10']], ['2', ['A2', 'A10']], ['3', ['A2', 'B1']]]);
});

test('an empty site returns an empty map using one parameterized query', async () => {
  let calls = 0;
  const grouped = await findMemberPlotNumbers(10, { query: async (_sql, params) => {
    calls++;
    assert.deepEqual(params, [10]);
    return { rows: [] };
  } });
  assert.equal(calls, 1);
  assert.equal(grouped.size, 0);
});

// These CTEs shadow real tables. The optional PostgreSQL test performs only
// SELECTs in a read-only transaction; no member or financial records are edited.
const fixtures = `WITH
  members AS (
    SELECT v.*, NULL::text AS phone, NULL::text AS email, NULL::text AS address, NULL::text AS city,
      NULL::text AS aadhar_no, NULL::text AS pan_no, NULL::text AS voter_id,
      NULL::text AS passport_no, NULL::text AS driving_license_no,
      NULL::text AS aadhar_front_url, NULL::text AS aadhar_back_url, NULL::text AS pan_card_url,
      NULL::text AS voter_id_url, NULL::text AS passport_url, NULL::text AS driving_license_url,
      NULL::text AS cheque_url, NULL::text AS other_kyc_url
    FROM (VALUES (1,10,'Buyer One'),(2,10,'Duplicate Buyer'),(3,10,'Duplicate Buyer'),
      (4,10,'Broker'),(5,10,'Buyer Renamed'),(6,20,'Buyer One'),(7,10,'Agent')) v(id,site_id,full_name)
  ),
  plot_data(id,site_id,plot_no,buyer_name,booking_by) AS (VALUES
    (101,10,'A2','Buyer One','Broker'),(102,10,'A10',' buyer one ',NULL),
    (103,10,'A3','Duplicate Buyer',NULL),(104,10,'B1','Duplicate Buyer',NULL),
    (105,10,'B2','Buyer One',NULL),(106,10,'C1',NULL,' broker '),
    (107,20,'OTHER SITE','Buyer One',NULL),(108,10,'C2','Nobody',NULL),
    (109,10,'D1','Duplicate Buyer',NULL),(110,10,'D2','Old spelling',NULL)),
  plots AS (SELECT *, CASE WHEN id = 109 THEN 2 WHEN id = 110 THEN 1 WHEN id = 105 THEN 6 END AS buyer_member_id,
    NULL::text AS plot_tag FROM plot_data),
  bookings(id,site_id,plot_id,client_member_id,status) AS (VALUES
    (1,10,101,5,'BOOKED'),(2,10,101,1,'CANCELLED'),(3,10,104,3,'BOOKED'),
    (4,10,105,6,'BOOKED'),(5,10,108,1,'CANCELLED'),(6,10,109,3,'BOOKED')),
  kyc_cases(id,site_id,client_member_id,status,updated_at) AS (VALUES
    (1,10,1,'VERIFIED',DATE '2026-01-01'),(2,10,1,'OPEN',DATE '2026-09-01'),
    (3,10,5,'OCR_DONE',DATE '2026-09-01'),(4,20,3,'VERIFIED',DATE '2026-09-01')),
  plot_commissions_v2(site_id,plot_id,agent_id) AS (VALUES (10,102,7),(20,102,6)),
  plot_commissions(site_id,plot_no,particular) AS (VALUES (10,'C1','Broker'))
`;

test('PostgreSQL resolves recorded buyers, ambiguous names, brokers and KYC within the site', {
  skip: process.env.PLOT_MEMBER_LINK_DB_TEST !== '1' && 'Set PLOT_MEMBER_LINK_DB_TEST=1 for read-only PostgreSQL verification',
}, async () => {
  const { default: pool } = await import('../src/config/db.js');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows } = await client.query(`${fixtures}
      SELECT p.id, plot_buyer.id AS buyer_member_id, ${PLOT_BUYER_KYC_STATUS} AS kyc_status
      FROM plots p ${PLOT_BUYER_MEMBER_JOIN} ${PLOT_BUYER_KYC_JOIN}
      WHERE p.site_id = $1 ORDER BY p.id`, [10]);
    assert.deepEqual(rows, [
      { id: 101, buyer_member_id: 5, kyc_status: 'OCR_DONE' },
      { id: 102, buyer_member_id: 1, kyc_status: 'VERIFIED' },
      { id: 103, buyer_member_id: null, kyc_status: null },
      { id: 104, buyer_member_id: 3, kyc_status: 'INCOMPLETE' },
      { id: 105, buyer_member_id: 1, kyc_status: 'VERIFIED' },
      { id: 106, buyer_member_id: null, kyc_status: null },
      { id: 108, buyer_member_id: null, kyc_status: null },
      { id: 109, buyer_member_id: 2, kyc_status: 'INCOMPLETE' },
      { id: 110, buyer_member_id: 1, kyc_status: 'VERIFIED' },
    ]);
    const grouped = await findMemberPlotNumbers(10, { query: (sql, params) => client.query(fixtures + sql, params) });
    assert.deepEqual(grouped.get('1'), ['A10', 'B2', 'D2']);
    assert.deepEqual(grouped.get('3'), ['B1']);
    assert.deepEqual(grouped.get('4'), ['A2', 'C1']);
    assert.deepEqual(grouped.get('5'), ['A2']);
    assert.deepEqual(grouped.get('7'), ['A10']);
    assert.deepEqual(grouped.get('2'), ['D1']);
    assert.equal(grouped.has('6'), false);
    const db = { query: (sql, params) => client.query(fixtures + sql, params) };
    assert.equal(await validatePlotBuyerMember(10, 2, db), 2);
    await assert.rejects(validatePlotBuyerMember(10, 6, db), { statusCode: 400 });
    await assert.rejects(validatePlotBuyerMember(10, 999, db), { statusCode: 400 });

    // Reproduce the deployment state where migration 149 has not added the
    // buyer_member_id column at all (different from a present, NULL column).
    const legacyFixtures = fixtures.replace(
      'CASE WHEN id = 109 THEN 2 WHEN id = 110 THEN 1 WHEN id = 105 THEN 6 END AS buyer_member_id,',
      '',
    );
    const legacyDb = { query: (sql, params) => client.query(legacyFixtures + sql, params) };
    const legacyGrouped = await findMemberPlotNumbers(10, legacyDb);
    assert.deepEqual(legacyGrouped.get('1'), ['A10', 'B2']);
    assert.deepEqual(legacyGrouped.get('3'), ['B1', 'D1']);
    assert.equal(legacyGrouped.has('2'), false);
    assert.equal(legacyGrouped.has('6'), false);
    const legacyBuyers = await client.query(`${legacyFixtures}
      SELECT p.id, plot_buyer.id AS buyer_member_id
      FROM plots p ${PLOT_BUYER_MEMBER_JOIN}
      WHERE p.site_id = $1 AND p.id IN (103, 104, 109, 110) ORDER BY p.id`, [10]);
    assert.deepEqual(legacyBuyers.rows, [
      { id: 103, buyer_member_id: null },
      { id: 104, buyer_member_id: 3 },
      { id: 109, buyer_member_id: 3 },
      { id: 110, buyer_member_id: null },
    ]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});

test('plot links retain distinct resale records and navigate with IDs, not plot numbers', () => {
  const grouped = groupMemberPlots([
    { id: 420, plot_no: 'A12', plot_tag: 'OLD', buyer_member_id: 1, broker_member_ids: [1, 2] },
    { id: 800, plot_no: 'A12', plot_tag: 'NEW', buyer_member_id: 1 },
    { id: 420, plot_no: 'A12', plot_tag: 'OLD', buyer_member_id: 1 },
    { id: 100, plot_no: ' A2 ', buyer_member_id: 1 },
    { id: null, plot_no: 'A9', buyer_member_id: 1 },
  ]);
  assert.deepEqual(grouped.get('1'), [
    { id: 100, plot_no: 'A2', plot_tag: null },
    { id: 420, plot_no: 'A12', plot_tag: 'OLD' },
    { id: 800, plot_no: 'A12', plot_tag: 'NEW' },
  ]);
  assert.deepEqual(grouped.get('2'), [{ id: 420, plot_no: 'A12', plot_tag: 'OLD' }]);
});

test('malformed member IDs cannot create a KYC association', async () => {
  for (const id of [null, '', 0, -1, 2.5, true, [1], '1abc', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(validatePlotBuyerMember(10, id, {
      query: () => assert.fail('Invalid IDs must not reach the database'),
    }), { statusCode: 400 });
  }
});
