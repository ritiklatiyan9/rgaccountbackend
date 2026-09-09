import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCreatorId, resolveEntryVisibility, canUserViewEntry } from '../src/services/entryVisibility.service.js';

test('creator selection accepts all, one ID, and deduplicated multiple IDs', () => {
  for (const value of [undefined, null, '', 'all']) assert.equal(parseCreatorId(value), null);
  assert.equal(parseCreatorId('12'), 12);
  assert.equal(parseCreatorId('12,34,12'), '12,34');
  assert.equal(parseCreatorId(['12', '34']), '12,34');
  for (const value of ['12,bad', '12,', '0', '-1', '12.3', '12 OR 1=1', '2147483648']) assert.equal(parseCreatorId(value), -1);
});

test('multiple selected users never expand a restricted user’s visibility', async () => {
  assert.deepEqual(await resolveEntryVisibility({ id: 7, role: 'user' }, 'daybook', '12,34'), { canViewAll: false, creatorId: 7 });
  const restricted = { id: 7, role: 'sub_admin', permissionsByModule: new Map([['cashflow', { can_view_all: false }]]) };
  assert.equal((await resolveEntryVisibility(restricted, 'cashflow', '12,34')).creatorId, 7);
  assert.equal(await canUserViewEntry(restricted, 'cashflow', 12), false);
  assert.equal(await canUserViewEntry(restricted, 'cashflow', 7), true);
});

test('authorized users retain every requested creator for data and aggregate queries', async () => {
  for (const role of ['admin', 'super_admin', 'sub_admin']) {
    const user = { id: 7, role, permissionsByModule: new Map([['cashflow', { can_view_all: true }]]) };
    assert.deepEqual(await resolveEntryVisibility(user, 'cashflow', '12,34'), { canViewAll: true, creatorId: '12,34' });
  }
});
