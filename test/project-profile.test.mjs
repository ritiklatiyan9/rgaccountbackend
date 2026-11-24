import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { plotModel } from '../src/models/Plot.model.js';
import { DEFAULT_PROJECT_PROFILE, validateProjectProfile, validateUnitMetadata, allowedUnitTypes, unitMetadataForWrite } from '../src/services/projectProfile.service.js';

const flatDetails = { tower: 'A', floor: '0', bedrooms: '2 BHK', carpet_area: '850', built_up_area: '1000', area_basis: 'carpet' };
const mixed = { inventory_type: 'mixed' };
test('unconfigured and legacy sites remain plots without invented approvals', () => {
  assert.deepEqual(allowedUnitTypes(), ['plot']);
  assert.deepEqual(allowedUnitTypes(DEFAULT_PROJECT_PROFILE), ['plot']);
  assert.equal(validateProjectProfile({}).authority_type, 'unconfigured');
  assert.equal(validateProjectProfile({}).rera_status, 'unconfigured');
  assert.deepEqual(validateUnitMetadata({}, undefined), { unit_type: 'plot', unit_details: {} });
});
test('local approval and RERA registration can coexist', () => {
  const p = validateProjectProfile({ inventory_type: 'mixed', authority_type: 'local', authority_name: 'Zila Panchayat', approval_number: 'LP-12', approval_date: '2026-08-01', rera_status: 'registered', promoter_name: 'Developer Pvt Ltd', rera_authority: 'UP RERA', rera_number: 'RERA-12', rera_valid_until: '2028-09-01' });
  assert.equal(p.authority_type, 'local'); assert.equal(p.rera_status, 'registered');
  assert.deepEqual(allowedUnitTypes(p), ['plot', 'flat']);
});
test('profile validation rejects incomplete and malformed professional fields', () => {
  for (const p of [null, [], { inventory_type: 'warehouses' }, { authority_type: 'mda' }, { rera_status: 'registered' }, { rera_status: 'applied' }, { rera_status: 'not_applicable' }, { expected_completion: '2026-02-30' }, { promoter_name: {} }, { promoter_name: 'a'.repeat(201) }]) assert.throws(() => validateProjectProfile(p), e => e.statusCode === 400);
});
test('approval dates are coherent and inactive profile fields are retained', () => {
  assert.throws(() => validateProjectProfile({ authority_type: 'other', authority_name: 'Authority', approval_number: '12', approval_date: '2026-09-01', approval_valid_until: '2026-08-01' }));
  assert.equal(validateProjectProfile({ rera_status: 'unconfigured', rera_number: 'saved reference' }).rera_number, 'saved reference');
});
test('flats are enabled only by the owning site profile', () => {
  assert.throws(() => validateUnitMetadata({ unit_type: 'flat', unit_details: flatDetails }, {}), /not enabled/);
  assert.throws(() => validateUnitMetadata({ unit_type: 'plot' }, { inventory_type: 'flats' }), /not enabled/);
  const result = validateUnitMetadata({ unit_type: 'flat', unit_details: flatDetails }, mixed);
  assert.equal(result.unit_details.floor, '0'); assert.equal(result.unit_details.carpet_area, 850);
});
test('flat fields reject missing carpet area and inconsistent or nonnumeric areas', () => {
  for (const patch of [{ carpet_area: null }, { carpet_area: 'NaN' }, { carpet_area: -1 }, { carpet_area: true }, { built_up_area: 100 }, { tower: '' }, { floor: '' }, { area_basis: 'gaz' }]) assert.throws(() => validateUnitMetadata({ unit_type: 'flat', unit_details: { ...flatDetails, ...patch } }, mixed));
});
test('existing unit type is immutable and historic financial fields are never part of a metadata write', () => {
  const old = Object.freeze({ id: 821, unit_type: 'plot', plot_size: '50.17', plot_size_mtr: '42.99', sale_price: '777777.13', unit_details: { khasra_no: '17/2' } });
  assert.throws(() => validateUnitMetadata({ unit_type: 'flat', unit_details: flatDetails }, mixed, old), e => e.statusCode === 409);
  assert.deepEqual(validateUnitMetadata({ buyer_name: 'New buyer' }, mixed, old), {});
  assert.deepEqual(validateUnitMetadata({ unit_details: { facing: 'North' }, sale_price: 0 }, mixed, old), { unit_type: 'plot', unit_details: { khasra_no: '17/2', facing: 'North' } });
  assert.equal(old.plot_size_mtr, '42.99'); assert.equal(old.sale_price, '777777.13');
});
test('unit metadata is validated against a server lookup, not a client-supplied site profile', async () => {
  const calls = [];
  const db = { query: async (sql, args) => { calls.push([sql, args]); return { rows: [{ project_profile: DEFAULT_PROJECT_PROFILE }] }; } };
  await assert.rejects(unitMetadataForWrite({ unit_type: 'flat', unit_details: flatDetails, project_profile: mixed }, 9, db), /not enabled/);
  assert.deepEqual(calls[0][1], [9]);
  await assert.rejects(unitMetadataForWrite({}, 10, { query: async () => ({ rows: [] }) }), e => e.statusCode === 404);
});
test('migration is additive and protects transfers and profile downgrades at the database boundary', () => {
  const sql = readFileSync(new URL('../src/migrations/152_site_project_profiles.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /(?:UPDATE\s+(?:sites|plots)\s+SET|DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN))/i);
  assert.match(sql, /DEFAULT 'plot'/); assert.match(sql, /ADD COLUMN IF NOT EXISTS project_profile/);
  assert.match(sql, /FOR SHARE/); assert.match(sql, /BEFORE INSERT OR UPDATE OF unit_type, site_id/); assert.match(sql, /BEFORE UPDATE OF project_profile/);
});

test('flat contracted sale area follows its selected area basis', async () => {
  const db = { query: async () => ({ rows: [{ project_profile: mixed }] }) };
  await assert.rejects(unitMetadataForWrite({ unit_type: 'flat', plot_size: 1000, unit_details: flatDetails }, 9, db), /must match/);
  const metadata = await unitMetadataForWrite({ unit_type: 'flat', plot_size: 850, unit_details: flatDetails }, 9, db);
  assert.equal(metadata.unit_details.carpet_area, 850);
  assert.equal('plot_size' in metadata, false);
  assert.throws(() => validateUnitMetadata({ unit_type: 'flat', unit_details: { ...flatDetails, area_basis: 'super_built_up' } }, mixed), /selected sale area basis/);
});


test('commercial shop profiles enable only compatible units and retain legacy mixed semantics', () => {
  assert.deepEqual(allowedUnitTypes(validateProjectProfile({ inventory_type: 'shops' })), ['shop']);
  assert.deepEqual(allowedUnitTypes(validateProjectProfile({ inventory_type: 'plots_shops' })), ['plot', 'shop']);
  assert.deepEqual(allowedUnitTypes(mixed), ['plot', 'flat']);
  const shop = { unit_type: 'shop', unit_details: { floor: 'G', carpet_area: '300', built_up_area: '360', area_basis: 'built_up' } };
  assert.equal(validateUnitMetadata(shop, { inventory_type: 'shops' }).unit_details.built_up_area, 360);
  for (const profile of [{}, mixed, { inventory_type: 'flats' }]) assert.throws(() => validateUnitMetadata(shop, profile), /not enabled/);
  for (const patch of [{ floor: '' }, { carpet_area: 0 }, { built_up_area: 250 }, { area_basis: 'gaz' }]) {
    assert.throws(() => validateUnitMetadata({ ...shop, unit_details: { ...shop.unit_details, ...patch } }, { inventory_type: 'shops' }));
  }
  assert.throws(() => validateUnitMetadata({ unit_type: 'shop', unit_details: shop.unit_details }, { inventory_type: 'plots_shops' }, { unit_type: 'plot' }), e => e.statusCode === 409);
});

test('shop contracted sale area follows its basis when creating and editing', async () => {
  const details = { floor: 'G', carpet_area: 300, built_up_area: 360, area_basis: 'built_up' };
  const db = { query: async () => ({ rows: [{ project_profile: { inventory_type: 'shops' } }] }) };
  await assert.rejects(unitMetadataForWrite({ unit_type: 'shop', plot_size: 300, unit_details: details }, 9, db), /Shop sale area must match/);
  const metadata = await unitMetadataForWrite({ unit_type: 'shop', plot_size: 360, unit_details: details }, 9, db);
  assert.equal(metadata.unit_type, 'shop');
  await assert.rejects(unitMetadataForWrite({ plot_size: 300 }, 9, db, { unit_type: 'shop', plot_size: 360, unit_details: details }), /must match/);
});

test('shop dimensions preserve inches and calculate sale area independently of measured carpet area', async () => {
  const details = { floor: 'G', carpet_area: 229.28, dimensions_ft: '9′3″ × 25′1″', area_basis: 'dimensions', dimensions_area: 999 };
  const db = { query: async () => ({ rows: [{ project_profile: { inventory_type: 'shops' } }] }) };
  const input = { unit_type: 'shop', plot_size: 232.0208, unit_details: details };
  const result = await unitMetadataForWrite(input, 7, db);
  assert.equal(result.unit_details.dimensions_area, 232.0208);
  assert.equal(result.unit_details.carpet_area, 229.28);
  await assert.rejects(unitMetadataForWrite({ ...input, plot_size: 999 }, 7, db), /must match/);
  await assert.rejects(unitMetadataForWrite({ ...input, unit_details: { ...details, dimensions_ft: '9′12″ × 25′0″' } }, 7, db), /feet and inches/);
  const irregular = await unitMetadataForWrite({ ...input, plot_size: 229.28, unit_details: { ...details, area_basis: 'carpet' } }, 7, db);
  assert.equal(irregular.unit_details.dimensions_area, 232.0208);
});

test('shop agreement fields survive older metadata updates and support explicit clearing', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE sites (id int, project_profile jsonb);
    INSERT INTO sites VALUES (7, '{"inventory_type":"shops"}');
    CREATE TABLE plots (id int, unit_type text, plot_size numeric, unit_details jsonb);
    INSERT INTO plots VALUES (1,'shop',200,'{"floor":"G","carpet_area":200,"area_basis":"carpet"}')`);
  const oldShop = (await db.query('SELECT * FROM plots WHERE id=1')).rows[0];
  const newFields = { draw_order: '08', unit_north: 'Shop 10', unit_south: 'Road', unit_east: 'Courtyard', unit_west: 'Shop 8' };
  const newUpdate = await unitMetadataForWrite({ unit_details: newFields }, 7, db, oldShop);
  const oldClientUpdate = await unitMetadataForWrite({ unit_details: { ...oldShop.unit_details, facing: 'east' } }, 7, db, oldShop);
  await plotModel.update(1, newUpdate, db);
  const edited = await plotModel.update(1, oldClientUpdate, db);
  assert.deepEqual(edited.unit_details, { ...oldShop.unit_details, ...newFields, facing: 'east' });
  const cleared = await unitMetadataForWrite({ unit_details: { unit_west: '' } }, 7, db, edited);
  assert.equal((await plotModel.update(1, cleared, db)).unit_details.unit_west, '');
  await assert.rejects(unitMetadataForWrite({ unit_details: { draw_order: 'x'.repeat(101) } }, 7, db, edited), /100 characters/);
  await assert.rejects(unitMetadataForWrite({ unit_details: { unit_north: {} } }, 7, db, edited), /must be text/);
});
