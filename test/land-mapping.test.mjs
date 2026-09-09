import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateCost, landStage, overSold, remainingArea, soldArea } from '../src/utils/landMapping.js';

const land = { total_amount: '1000000', land_size_bigha: '10', land_size_gaz: '30250' }; // 1 bigha = 3025 gaz
const noArea = { total_amount: '1000000', land_size_bigha: null, land_size_gaz: null };
const sale = (gaz, extra = {}) => ({ status: 'open', area_gaz: gaz, area_bigha: gaz / 3025, purchase_cost: 0, ...extra });

test('cost share follows area, falls back to the unallocated remainder', () => {
  assert.equal(allocateCost(land, [], sale(3025)), 100000); // one bigha of ten
  assert.equal(allocateCost(land, [], sale(60500)), 1000000); // never more than the land cost
  assert.equal(allocateCost(noArea, [sale(0, { purchase_cost: 700000 })], sale(0)), 300000);
  assert.equal(allocateCost(noArea, [sale(0, { purchase_cost: 700000, status: 'cancelled' })], sale(0)), 1000000);
});

test('a land cannot be oversold; cancelled sales free their area', () => {
  assert.equal(overSold(land, [], sale(30250)), null);
  assert.match(overSold(land, [sale(20000)], sale(10251)), /Only 10,250 gaz/);
  assert.equal(overSold(land, [sale(20000, { status: 'cancelled' })], sale(30250)), null);
  assert.equal(overSold(noArea, [sale(0)], sale(99999)), null); // no area recorded → nothing to check
  assert.equal(soldArea(land, [sale(1000), sale(2000)]), 3000);
  assert.equal(remainingArea(land, [sale(30250)]), 0);
});

test('stage: paying → held → partly sold → sold', () => {
  assert.equal(landStage(land, [], 999999), 'paying');
  assert.equal(landStage(land, [], 1000000), 'held');
  assert.equal(landStage(land, [sale(3025)], 0), 'partly_sold');
  assert.equal(landStage(land, [sale(30250)], 0), 'sold');
  assert.equal(landStage(noArea, [sale(0)], 0), 'sold'); // no area → one sale sells the lot
});
