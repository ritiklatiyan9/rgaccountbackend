import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeShares } from '../src/controllers/sitePartnerShare.controller.js';

test('a valid partner split is accepted and normalised', () => {
  const { error, shares } = normalizeShares([
    { member_id: '7', share_pct: '33.33', notes: '  founding partner  ' },
    { member_id: 9, share_pct: 33.33 },
    { member_id: 11, share_pct: 33.34 },
  ]);
  assert.equal(error, undefined);
  assert.deepEqual(shares, [
    { memberId: 7, pct: 33.33, notes: 'founding partner' },
    { memberId: 9, pct: 33.33, notes: null },
    { memberId: 11, pct: 33.34, notes: null },
  ]);
});

test('a partial split is allowed; the remainder stays unallocated', () => {
  const { error, shares } = normalizeShares([{ member_id: 1, share_pct: 40 }]);
  assert.equal(error, undefined);
  assert.equal(shares.reduce((sum, s) => sum + s.pct, 0), 40);
});

test('shares over 100% are rejected', () => {
  const { error } = normalizeShares([
    { member_id: 1, share_pct: 60 },
    { member_id: 2, share_pct: 41 },
  ]);
  assert.match(error, /cannot exceed 100%/);
});

test('a duplicated client is rejected instead of double-counted', () => {
  const { error } = normalizeShares([
    { member_id: 4, share_pct: 25 },
    { member_id: 4, share_pct: 25 },
  ]);
  assert.match(error, /listed twice/);
});

test('zero, negative, non-numeric and client-less rows are rejected', () => {
  for (const bad of [
    [{ member_id: 4, share_pct: 0 }],
    [{ member_id: 4, share_pct: -10 }],
    [{ member_id: 4, share_pct: 'abc' }],
    [{ member_id: null, share_pct: 10 }],
  ]) assert.ok(normalizeShares(bad).error, `expected rejection for ${JSON.stringify(bad)}`);
  assert.ok(normalizeShares(undefined).error);
});
