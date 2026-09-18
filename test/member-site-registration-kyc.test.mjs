import assert from 'node:assert/strict';
import test from 'node:test';
import { reuseVerifiedKycForMember } from '../src/services/memberPhoneReuse.service.js';

const source = {
  id: 10,
  full_name: 'Ritik Latiyan',
  phone: '+91 98765-43210',
  address: 'Verified address',
  aadhar_no: '1234 5678 9012',
  verified_kyc_case_id: 80,
  kyc_verified_by: 7,
  kyc_verified_at: '2026-09-10T09:00:00.000Z',
};
const targetMember = {
  id: 22,
  full_name: 'RITIK LATIYAN',
  phone: '9876543210',
  address: null,
  site_id: 5,
};

test('site registration completes an existing unfinished KYC case', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("status = 'VERIFIED'") && sql.includes('FOR SHARE')) return { rows: [] };
      if (sql.includes("status NOT IN ('VERIFIED', 'REJECTED')")) return { rows: [{ id: 91 }] };
      if (sql.includes('UPDATE kyc_cases')) return { rows: [{ id: 91 }] };
      return { rows: [] };
    },
  };

  const result = await reuseVerifiedKycForMember(db, {
    source, targetMember, siteId: 5, userId: 3,
  });

  assert.deepEqual(result, { kycReused: true, reason: 'REUSED', kycCaseId: 91 });
  const profileUpdate = calls.find((call) => call.sql.includes('UPDATE members'));
  assert.ok(profileUpdate);
  assert.match(profileUpdate.sql, /address = \$\d+/);
  assert.ok(profileUpdate.params.includes('Verified address'));
  const caseUpdate = calls.find((call) => call.sql.includes('UPDATE kyc_cases'));
  assert.deepEqual(caseUpdate.params, [7, source.kyc_verified_at, 80, 91]);
});

test('site registration creates an audited verified case when no unfinished case exists', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("status = 'VERIFIED'") && sql.includes('FOR SHARE')) return { rows: [] };
      if (sql.includes("status NOT IN ('VERIFIED', 'REJECTED')")) return { rows: [] };
      if (sql.includes('INSERT INTO kyc_cases')) return { rows: [{ id: 92 }] };
      return { rows: [] };
    },
  };

  const result = await reuseVerifiedKycForMember(db, {
    source, targetMember, siteId: 5, userId: 3,
  });

  assert.equal(result.kycReused, true);
  assert.equal(result.kycCaseId, 92);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO kyc_cases'));
  assert.deepEqual(insert.params, [22, 5, 3, 7, source.kyc_verified_at, 80]);
});

test('site registration never replaces an already verified target KYC', async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 77 }] };
    },
  };

  const result = await reuseVerifiedKycForMember(db, {
    source, targetMember, siteId: 5, userId: 3,
  });

  assert.deepEqual(result, { kycReused: false, reason: 'ALREADY_VERIFIED', kycCaseId: 77 });
  assert.equal(calls.length, 1);
});

test('site registration refuses to reuse KYC for a different registered name', async () => {
  let queried = false;
  const result = await reuseVerifiedKycForMember({ query: async () => { queried = true; } }, {
    source,
    targetMember: { ...targetMember, full_name: 'Another Person' },
    siteId: 5,
    userId: 3,
  });

  assert.deepEqual(result, { kycReused: false, reason: 'NAME_MISMATCH' });
  assert.equal(queried, false);
});

test('site registration does not invent verification when the source has no verified case', async () => {
  let queried = false;
  const result = await reuseVerifiedKycForMember({ query: async () => { queried = true; } }, {
    source: { ...source, verified_kyc_case_id: null },
    targetMember,
    siteId: 5,
    userId: 3,
  });

  assert.deepEqual(result, { kycReused: false, reason: 'NO_VERIFIED_SOURCE' });
  assert.equal(queried, false);
});
