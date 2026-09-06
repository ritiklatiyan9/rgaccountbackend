import assert from 'node:assert/strict';
import test from 'node:test';
import { addressParts, cacheKey, coordinates, invalidateChangedAddress } from '../src/services/clientLocation.js';
import { buildClientMap, CLIENT_MAP_SQL } from '../src/services/clientMapAnalytics.service.js';
import { geocodeAddress, geocodePendingMembers, searchAttempts, selectGeocodeHit } from '../src/services/geocode.service.js';

test('normalizes locality spacing, state aliases and PIN formatting into a shared cache key', () => {
  assert.equal(cacheKey({ city: '  Meerut ', state: 'U.P.', pincode: '250 001' }), cacheKey({ city: 'MEERUT', state: 'Uttar Pradesh', pincode: '250001' }));
  assert.notEqual(cacheKey({ city: 'Meerut', village: 'A' }), cacheKey({ city: 'Meerut', village: 'B' }));
});

test('extracts an unambiguous PIN and state from saved address without guessing the street or city', () => {
  const result = addressParts({ address: 'House 22, Meerut, Uttar Pradesh 250001' });
  assert.equal(result.pincode, '250001'); assert.equal(result.state, 'UTTAR PRADESH');
  assert.equal(result.city, ''); assert.equal(result.inferred_pincode, true); assert.equal(result.can_geocode, true);
  assert.equal(addressParts({ address: 'Mobile 9825000199' }).pincode, '');
  assert.equal(addressParts({ address: '250001 or 250002' }).pincode, '');
  assert.equal(addressParts({ address: '250001', pincode: '123' }).pincode, '');
  assert.equal(addressParts({ pincode: '000000' }).invalid_pincode, true);
  assert.equal(addressParts({ city: 'N/A', address: '-' }).has_address, false);
});

test('validates coordinate pairs without converting missing values into zero', () => {
  for (const pair of [[null, 77], ['', 77], [' ', 77], [true, 77], [28, null], [91, 77], [28, 181], ['NaN', 1]]) assert.equal(coordinates(...pair), null);
  assert.deepEqual(coordinates('0', '-180'), { lat: 0, lng: -180 });
});

test('address changes invalidate only automatic or failed locations, preserving deliberate pins', () => {
  const existing = { city: 'Meerut', geocode_source: 'nominatim' };
  assert.equal(invalidateChangedAddress({ city: 'Delhi' }, existing).latitude, null);
  assert.equal(Object.hasOwn(invalidateChangedAddress({ city: ' MEERUT ' }, existing), 'latitude'), false);
  assert.equal(Object.hasOwn(invalidateChangedAddress({ city: 'Delhi' }, { ...existing, geocode_source: 'manual' }), 'latitude'), false);
  assert.equal(invalidateChangedAddress({ city: 'Delhi', latitude: 28, longitude: 77 }, existing).latitude, 28);
});

test('map includes all members and conserves coverage with incomplete, invalid and duplicate coordinates', () => {
  const map = buildClientMap([
    { id: 1, name: 'A', lat: 28, lng: 77, source: 'manual', total_paid: '12.34' },
    { id: 2, name: 'B', lat: 28, lng: null, city: 'Meerut', member_type: 'broker', member_types: ['broker', 'client'] },
    { id: 3, name: 'C', address: 'House 25' }, { id: 1 },
    { id: 4, name: 'D', lat: 28, lng: 77, source: 'nominatim' },
  ], { siteId: 5 });
  assert.equal(map.members.length, 4); assert.equal(map.summary.total, 4);
  assert.equal(map.summary.geocoded + map.unresolved.count, map.summary.total);
  assert.equal(map.summary.manual, 1); assert.equal(map.summary.approx, 1);
  assert.equal(map.summary.ready_to_locate, 1); assert.equal(map.members[0].total_paid, 12.34);
  assert.deepEqual(map.members[1].member_types, ['BROKER', 'CLIENT']);
  assert.equal(map.members[2].location_status, 'needs_address');
});

test('map does not truncate sites above the previous 3000-member cap', () => {
  const map = buildClientMap(Array.from({ length: 10001 }, (_, id) => ({ id, lat: 28, lng: 77 })));
  assert.equal(map.members.length, 10001); assert.equal(map.summary.geocoded, 10001);
});

test('geocoding only sends locality fields and never falls back past a supplied PIN', () => {
  const attempts = searchAttempts({ name: 'Private Name', address: 'Private House 11', city: 'Meerut', state: 'UP', pincode: '250001' });
  assert.equal(attempts.length, 2);
  for (const attempt of attempts) { assert.equal(attempt.params.postalcode, '250001'); assert.doesNotMatch(JSON.stringify(attempt), /Private/); }
  assert.equal(searchAttempts({ village: 'Village', district: 'Meerut' })[0].precision, 'village');
});

const hit = (extra = {}) => ({ lat: '28', lon: '77', address: { state: 'Uttar Pradesh', country_code: 'in', postcode: '250001' }, ...extra });
test('rejects mismatched states, PINs, invalid coordinates and ambiguous town names', () => {
  assert.equal(selectGeocodeHit([hit()], { state: 'Rajasthan' }, 'city'), null);
  assert.equal(selectGeocodeHit([hit()], { pincode: '250002' }, 'pincode'), null);
  assert.equal(selectGeocodeHit([hit({ lat: null })], {}, 'city'), null);
  assert.equal(selectGeocodeHit([hit(), hit({ lat: 35 })], { city: 'Town' }, 'city'), null);
  assert.equal(selectGeocodeHit([hit()], { state: 'UP', pincode: '250001' }, 'city').precision, 'city');
});

test('uses cached coordinates and negative cache without contacting a provider', async () => {
  for (const lat of [28, null]) {
    const result = await geocodeAddress({ city: 'Meerut' }, { db: { query: async () => ({ rows: [{ lat, lng: 77, precision: 'city', source: 'nominatim' }] }) }, fetchImpl: () => { throw new Error('Unexpected network'); } });
    assert.equal(result?.lat ?? null, lat);
  }
});

test('caches successful misses but never caches provider failures', async () => {
  for (const failed of [false, true]) {
    const queries = [];
    const options = { db: { query: async (sql, args) => { queries.push([sql, args]); return { rows: [] }; } }, sleep: async () => {}, fetchImpl: async () => ({ ok: !failed, status: 429, json: async () => [] }) };
    if (failed) await assert.rejects(geocodeAddress({ city: 'Meerut' }, options), /429/);
    else assert.equal(await geocodeAddress({ city: 'Meerut' }, options), null);
    assert.equal(queries.length, failed ? 1 : 2);
  }
});

test('deadline pauses before making a network call or caching a miss', async () => {
  await assert.rejects(geocodeAddress({ city: 'Meerut' }, {
    db: { query: async () => ({ rows: [] }) }, deadline: 0,
    fetchImpl: () => { throw new Error('Unexpected network'); },
  }), { code: 'BATCH_DEADLINE' });
});

function fakeBatchDb(rows, { locked = true, updateCount = 1 } = {}) {
  const statements = []; let released = false;
  const client = { query: async (sql, args) => {
    statements.push({ sql, args });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (sql.includes('SELECT id, address')) return { rows };
    return { rows: [], rowCount: updateCount };
  }, release: () => { released = true; } };
  return { db: { connect: async () => client }, statements, released: () => released };
}

test('batch skips missing addresses before limiting, shares duplicate lookups, and resumes past misses', async () => {
  const fake = fakeBatchDb([{ id: 1 }, { id: 2, city: 'A' }, { id: 3, city: 'A' }, { id: 4, city: 'B' }]);
  let calls = 0;
  const result = await geocodePendingMembers({ siteId: 5, limit: 2 }, { db: fake.db, lookup: async () => { calls++; return null; } });
  assert.equal(calls, 1); assert.equal(result.processed, 2); assert.equal(result.unmatched, 2);
  assert.equal(result.remaining, 1); assert.equal(result.next_after_id, 3); assert.equal(result.skipped_no_address, 1);
  assert.equal(fake.released(), true);
  const next = await geocodePendingMembers({ siteId: 5, afterId: 3 }, { db: fake.db, lookup: async () => null });
  assert.equal(next.processed, 1); assert.equal(next.has_more, false);
});

test('busy batches release the connection and never start a second lookup', async () => {
  const fake = fakeBatchDb([], { locked: false });
  const result = await geocodePendingMembers({ siteId: 5 }, { db: fake.db, lookup: () => { throw new Error('Unexpected lookup'); } });
  assert.equal(result.busy, true); assert.equal(fake.statements.length, 1); assert.equal(fake.released(), true);
});

test('provider outage retains the cursor for retry and releases the worker lock', async () => {
  const fake = fakeBatchDb([{ id: 2, city: 'A' }]);
  const result = await geocodePendingMembers({ siteId: 5 }, { db: fake.db, lookup: async () => { throw new Error('timeout'); } });
  assert.equal(result.failed, 1); assert.equal(result.processed, 0); assert.equal(result.next_after_id, 0); assert.equal(result.has_more, true);
  assert.match(fake.statements.at(-1).sql, /pg_advisory_unlock/); assert.equal(fake.released(), true);
});

test('a concurrent profile edit is not counted as a successful update', async () => {
  const fake = fakeBatchDb([{ id: 2, city: 'A' }], { updateCount: 0 });
  const result = await geocodePendingMembers({ siteId: 5 }, { db: fake.db, lookup: async () => ({ lat: 28, lng: 77, precision: 'city' }) });
  assert.equal(result.geocoded, 0);
  const update = fake.statements.find((q) => q.sql.startsWith('UPDATE'));
  assert.equal(update.args[4], 5); assert.match(update.sql, /jsonb_build_array/);
});

test('PostgreSQL allocates each plot once, preserves reversals and excludes other sites', { skip: process.env.CLIENT_MAP_DB_TEST !== '1' && 'Set CLIENT_MAP_DB_TEST=1 for read-only PostgreSQL verification' }, async () => {
  const { default: pool } = await import('../src/config/db.js');
  const client = await pool.connect();
  const fixture = `members(id,site_id,full_name,member_type,member_types,status,address,city,village,district,state,pincode,occupation,latitude,longitude,geocode_source,geocode_precision) AS (
    SELECT id, site_id, name, 'CLIENT', ARRAY['CLIENT'], status, NULL::text, 'Meerut', NULL::text, NULL::text, 'UP', '250001', NULL::text, NULL::numeric, NULL::numeric, NULL::text, NULL::text
    FROM (VALUES (1,5,'SAME','active'), (2,5,'SAME','active'), (3,5,'UNIQUE','active'), (4,6,'UNIQUE','active'), (5,5,'DELETED','deleted')) v(id,site_id,name,status)),
    plots(id,site_id,buyer_member_id,buyer_name,status,sale_price) AS (VALUES
      (1,5,1,'SAME','SOLD',100::numeric), (2,5,2,'SAME','SOLD',200), (3,5,NULL,'SAME','SOLD',300),
      (4,5,NULL,'UNIQUE','SOLD',400), (5,6,4,'UNIQUE','SOLD',500), (6,5,5,'DELETED','SOLD',600),
      (7,5,NULL,'SAME','CANCELLED',700), (8,5,1,'UNIQUE','SOLD',100)),
    bookings(id,site_id,plot_id,client_member_id,status) AS (VALUES (1,5,7,2,'BOOKED'), (2,5,1,2,'BOOKED'), (3,5,7,1,'CANCELLED')),
    plot_payments(id,site_id,plot_id) AS (VALUES (1,5,1),(2,5,1),(3,5,2),(4,5,3),(5,5,4),(6,6,5),(7,5,6),(8,5,7),(9,5,8)),
    ledger_entries(site_id,source_key,source_id,credit) AS (VALUES
      (5,'plot_payments',1,50::numeric),(5,'plot_payments',2,-10),(5,'plot_payments',3,250),
      (5,'plot_payments',4,30),(5,'plot_payments',5,70),(6,'plot_payments',6,500),
      (5,'plot_payments',7,60),(5,'plot_payments',8,20),(5,'plot_payments',9,0), (5,'expenses',1,900))`;
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query(CLIENT_MAP_SQL.replace(/^WITH/, `WITH ${fixture},`), [5]);
    const map = buildClientMap(result.rows[0].members, { siteId: 5, unlinked: result.rows[0].unlinked });
    assert.deepEqual(map.members.map((m) => [m.id, m.plot_count, m.total_paid, m.outstanding]), [[1,2,40,160],[2,2,270,0],[3,1,70,330]]);
    assert.deepEqual(map.unlinked, { plots: 2, total_paid: 90 });
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});
