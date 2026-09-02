import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('migration 135 adds the three people arrays and backfills from the single columns', async () => {
  const migration = await readSource('src/migrations/135_noc_multi_people.js');
  for (const col of ['noc_farmer_member_ids', 'noc_authorized_member_ids', 'noc_client_member_ids']) {
    assert.match(migration, new RegExp(col));
  }
  assert.match(migration, /noc_farmer_member_ids = ARRAY\[noc_farmer_member_id\]/);
  assert.match(migration, /noc_authorized_member_ids = ARRAY\[noc_authorized_member_id\]/);
});

test('saveRegistryNoc persists the arrays, keeps legacy single columns, and its params line up', async () => {
  const controller = await readSource('src/controllers/registry.controller.js');
  const updateStart = controller.indexOf('noc_farmer_member_ids = $14::integer[]');
  assert.ok(updateStart > -1, 'UPDATE must write noc_farmer_member_ids as $14');
  assert.match(controller, /noc_authorized_member_ids = \$15::integer\[\]/);
  assert.match(controller, /noc_client_member_ids = \$16::integer\[\]/);
  // Legacy single columns stay synced to the first pick for older readers.
  assert.match(controller, /noc_farmer_member_id = \$12::integer/);
  assert.match(controller, /const farmerMemberId = farmerMemberIds\?\.\[0\] \|\| null/);
  // The params array ends with the three arrays, in placeholder order.
  assert.match(controller, /farmerMemberId,\s*authorizedMemberId,\s*farmerMemberIds,\s*authorizedMemberIds,\s*clientMemberIds,\s*\]\s*\)/);
  // Extra purchasers face the KYC gate.
  assert.match(controller, /clientMemberIds\?\.length/);
  assert.match(controller, /k\.client_member_id = m\.id AND k\.status = 'VERIFIED'/);
});

test('NOC payload returns the people arrays with single-value fallbacks', async () => {
  const controller = await readSource('src/controllers/registry.controller.js');
  assert.match(controller, /farmers,\s*authorized_signatories: authorizedSignatories,\s*client_members: clientMembers,/);
  assert.match(controller, /registry\.noc_farmer_member_ids\?\.length\s*\?\s*registry\.noc_farmer_member_ids\s*:\s*\[registry\.noc_farmer_member_id\]\.filter\(Boolean\)/);
});
