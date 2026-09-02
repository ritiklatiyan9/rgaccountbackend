import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyMemberTypes, samePhone } from '../src/controllers/member.controller.js';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('a member can hold several roles, with the first as the primary', () => {
  // Create: an explicit set leads with the primary named alongside it.
  const created = applyMemberTypes({ member_type: 'FARMER' }, { member_types: ['CLIENT', 'FARMER'] });
  assert.deepEqual(created.member_types, ['FARMER', 'CLIENT']);
  assert.equal(created.member_type, 'FARMER');

  // A CSV (what multipart/form-data sends) is the same thing, junk dropped.
  const fromForm = applyMemberTypes({}, { member_types: 'client,farmer,NOT_A_TYPE,CLIENT' });
  assert.deepEqual(fromForm.member_types, ['CLIENT', 'FARMER']);
  assert.equal(fromForm.member_type, 'CLIENT');

  // Older single-type forms keep the roles the member already holds.
  const legacy = applyMemberTypes({ member_type: 'EMPLOYEE' }, {}, { member_type: 'CLIENT', member_types: ['CLIENT', 'FARMER'] });
  assert.deepEqual(legacy.member_types, ['EMPLOYEE', 'CLIENT', 'FARMER']);

  // Touching neither field writes neither.
  assert.deepEqual(applyMemberTypes({ city: 'AGRA' }, {}, { member_types: ['CLIENT'] }), { city: 'AGRA' });
});

test('an unchanged phone never blocks an edit, and every role is matched', () => {
  const controller = read('../src/controllers/member.controller.js');
  const model = read('../src/models/Member.model.js');
  const clients = read('../../rgaccount/src/pages/Clients.jsx');

  assert.match(read('../src/migrations/131_member_multiple_types.js'), /ADD COLUMN IF NOT EXISTS member_types TEXT\[\]/);
  // The duplicate-phone 409 only fires when the phone is actually changing.
  assert.match(controller, /phoneCheck\.rows\.length > 0 && !samePhone\(data\.phone, existing\.phone\)/);
  // Formatting alone is not a change, so re-saving an existing number is not blocked.
  assert.ok(samePhone('9927669955 ', '99276-69955'));
  assert.ok(!samePhone('9927669955', '9927669956'));
  assert.ok(!samePhone('9927669955', ''));
  // Filters and counts read the whole role set, not just the primary.
  assert.match(model, /\$2 = ANY\(COALESCE\(m\.member_types, ARRAY\[m\.member_type\]\)\)/);
  assert.match(model, /'FARMER'\s+= ANY\(roles\)/);
  assert.match(clients, /rolesOf\(m\)\.includes\(filterType\)/);
  assert.match(clients, /toggleMemberType/);
});
