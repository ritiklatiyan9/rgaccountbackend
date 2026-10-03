import test from 'node:test';
import assert from 'node:assert/strict';
import { entryVisibilityKey, sameEntryVisibility } from '../src/services/driveShareVisibility.js';

test('visibility comparison ignores key order and equivalent creator representations', () => {
  assert.ok(sameEntryVisibility({ canViewAll: true, creatorId: null }, { creatorId: null, canViewAll: true }));
  assert.ok(sameEntryVisibility({ canViewAll: false, creatorId: 8 }, { creatorId: '008', canViewAll: false }));
  assert.ok(sameEntryVisibility({ canViewAll: true, creatorId: '8,12' }, { creatorId: [12, 8, '8'], canViewAll: true }));
});

test('visibility comparison rejects actual permission or creator changes', () => {
  for (const [left, right] of [
    [{ canViewAll: true, creatorId: null }, { canViewAll: false, creatorId: 8 }],
    [{ canViewAll: false, creatorId: 8 }, { canViewAll: false, creatorId: 9 }],
    [{ canViewAll: true, creatorId: null }, { canViewAll: true, creatorId: 8 }],
    [{ canViewAll: true, creatorId: '8,12' }, { canViewAll: true, creatorId: '8,13' }],
    [{ canViewAll: true, creatorId: -1 }, { canViewAll: true, creatorId: null }],
  ]) assert.equal(sameEntryVisibility(left, right), false);
});

test('malformed snapshots never match, even when both are malformed', () => {
  for (const visibility of [null, {}, { canViewAll: true }, { canViewAll: 'true', creatorId: null },
    ...[undefined, '', [], 0, -2, '8,', '-1,8', 'x', 2147483648].map((creatorId) => ({ canViewAll: true, creatorId }))]) {
    assert.equal(entryVisibilityKey(visibility), null);
    assert.equal(sameEntryVisibility(visibility, visibility), false);
  }
});
