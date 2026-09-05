import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertMemberSiteAccess,
  findAccessiblePhoneMatches,
  findVerifiedReuseSource,
  mergeVerifiedKycProfile,
  normalizeMemberName,
  normalizeMemberPhone,
} from '../src/services/memberPhoneReuse.service.js';

test('mobile normalization accepts local, leading-zero and +91 formats only when complete', () => {
  assert.equal(normalizeMemberPhone('98765 43210'), '9876543210');
  assert.equal(normalizeMemberPhone('09876543210'), '9876543210');
  assert.equal(normalizeMemberPhone('+91 98765-43210'), '9876543210');
  assert.equal(normalizeMemberPhone('0091 98765-43210'), '9876543210');
  assert.equal(normalizeMemberPhone('987654321'), '');
  assert.equal(normalizeMemberPhone('+1 9876543210'), '');
});

test('name matching ignores case, spaces and punctuation', () => {
  assert.equal(normalizeMemberName(' Rajesh-Kumar '), 'RAJESHKUMAR');
  assert.equal(normalizeMemberName('RAJESH KUMAR'), 'RAJESHKUMAR');
  assert.equal(normalizeMemberName(' ऋतिक-कुमार '), 'ऋतिककुमार');
});

test('verified KYC fields replace retyped identity data without changing site roles', () => {
  const merged = mergeVerifiedKycProfile({
    site_id: 22,
    member_type: 'BROKER',
    member_types: ['BROKER', 'CLIENT'],
    team: 'SALES NORTH',
    status: 'ACTIVE',
    full_name: 'RAJESH KUMAR',
    phone: '9876543210',
    email: 'new@example.com',
  }, {
    full_name: 'RAJESH KUMAR',
    phone: '+91 98765 43210',
    email: 'verified@example.com',
    aadhar_no: '111122223333',
    aadhar_front_url: 'https://files.example/aadhaar-front.jpg',
    team: 'OLD TEAM',
    status: 'INACTIVE',
  });

  assert.equal(merged.site_id, 22);
  assert.equal(merged.member_type, 'BROKER');
  assert.deepEqual(merged.member_types, ['BROKER', 'CLIENT']);
  assert.equal(merged.team, 'SALES NORTH');
  assert.equal(merged.status, 'ACTIVE');
  assert.equal(merged.phone, '9876543210');
  assert.equal(merged.email, 'verified@example.com');
  assert.equal(merged.aadhar_no, '111122223333');
  assert.equal(merged.aadhar_front_url, 'https://files.example/aadhaar-front.jpg');
});

test('blank source values do not erase useful submitted values', () => {
  const merged = mergeVerifiedKycProfile(
    { full_name: 'ANITA DEVI', phone: '9123456789', email: 'anita@example.com' },
    { full_name: 'ANITA DEVI', phone: '9123456789', email: '' }
  );
  assert.equal(merged.email, 'anita@example.com');
});

test('lookup queries are organization and site-access scoped', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
  await findAccessiblePhoneMatches(db, {
    user: { id: 7, role: 'sub_admin', organization_id: 3 },
    siteId: 22,
    phone: '9876543210',
  });
  assert.match(calls[0].sql, /s\.organization_id = \$1/);
  assert.match(calls[0].sql, /permitted_site\.user_id = \$5/);
  assert.deepEqual(calls[0].values, [3, '9876543210', 22, false, 7]);
});

test('automatic KYC reuse chooses the verified registration with the same normalized name', async () => {
  const db = {
    query: async (_sql, values) => {
      assert.deepEqual(values, [3, '9876543210', 22, true, 7]);
      return { rows: [
        { id: 1, full_name: 'ANITA SHARMA' },
        { id: 2, full_name: 'RITIK-KUMAR' },
      ] };
    },
  };
  const source = await findVerifiedReuseSource(db, {
    user: { id: 7, role: 'admin', organization_id: 3 },
    siteId: 22,
    phone: '+91 9876543210',
    fullName: 'Ritik Kumar',
  });
  assert.equal(source.id, 2);
});

test('target-site checks use the organization and sub-admin site assignment', async () => {
  const calls = [];
  const db = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [{ id: 22 }] }; } };
  assert.deepEqual(await assertMemberSiteAccess(db, {
    id: 7, role: 'sub_admin', organization_id: 3,
  }, 22), { id: 22 });
  assert.match(calls[0].sql, /permitted_site\.user_id = \$3/);
  assert.deepEqual(calls[0].values, [22, 3, 7]);
});
