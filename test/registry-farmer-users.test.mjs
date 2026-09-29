import assert from 'node:assert/strict';
import test from 'node:test';
import { registryFarmerUsers } from '../src/utils/registryFarmerUsers.js';

test('farmer choices include farmer and member records once per name', () => {
  assert.deepEqual(registryFarmerUsers([
    { name: ' Ram  Singh ', phone: '111' },
    { name: 'RAM SINGH', phone: '222' },
    { name: 'Sita Devi', phone: '333' },
  ], ['ram singh', 'Legacy Farmer']), [
    { name: 'Legacy Farmer', phones: [] },
    { name: 'Ram Singh', phones: ['111', '222'] },
    { name: 'Sita Devi', phones: ['333'] },
  ]);
});
