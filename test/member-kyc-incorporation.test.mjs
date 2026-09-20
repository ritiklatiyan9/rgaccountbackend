import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMatchingKycIdentity, incorporateMemberKyc, listMemberKycSources,
} from '../src/services/memberKycIncorporation.service.js';

const user = { id: 7, role: 'sub_admin', organization_id: 3 };
const target = { id: 22, site_id: 5, full_name: 'Test Client', phone: '9876543210', team: 'Target team' };
const source = {
  id: 10, site_id: 2, site_name: 'Source site', source_site_name: 'Source site',
  full_name: 'TEST CLIENT', phone: '+91 98765-43210', address: 'Verified address',
  aadhar_no: '1111 2222 3333', pan_no: 'ABCDE1234F',
  photo: 's3://test-bucket/kyc/photo.png', verified_kyc_case_id: 80,
  kyc_verified_by: 8, kyc_verified_at: '2026-09-01T09:00:00Z',
};

function fixture(options = {}) {
  const calls = [];
  let released = false;
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === 'SELECT * FROM members WHERE id = $1') return { rows: options.missing ? [] : [{ ...target, ...options.target }] };
      if (sql.includes('SELECT s.id, s.name')) {
        assert.match(sql, /s.organization_id = \$2/);
        assert.match(sql, /permitted_site.user_id = \$3/);
        assert.deepEqual(values, [5, 3, 7]);
        return { rows: options.denied ? [] : [{ id: 5, name: 'Target site' }] };
      }
      if (sql.includes('source_site.name AS source_site_name')) {
        assert.match(sql, /source_site.organization_id = \$1/);
        assert.match(sql, /permitted_site.site_id = source_site.id/);
        assert.match(sql, /m.site_id <> \$3/);
        assert.match(sql, /m.id = \$6/);
        assert.deepEqual(values, [3, '9876543210', 5, false, 7, 10]);
        return { rows: options.unavailable ? [] : [{ ...source, ...options.source }] };
      }
      if (sql.includes('s.name AS site_name')) return { rows: options.matches || [source] };
      if (sql.includes('SELECT id FROM kyc_cases WHERE id = $1')) return { rows: options.changed ? [] : [{ id: 80 }] };
      if (sql.includes("status = 'VERIFIED'") && sql.includes('client_member_id = $1') && sql.includes('SELECT id FROM kyc_cases')) {
        return { rows: options.alreadyVerified ? [{ id: 77 }] : [] };
      }
      if (sql.includes("status NOT IN ('VERIFIED', 'REJECTED')")) return { rows: options.openCase ? [{ id: 91 }] : [] };
      if (sql.includes('UPDATE kyc_cases') || sql.includes('INSERT INTO kyc_cases')) return { rows: [{ id: 91 }] };
      if (sql.includes('WITH RECURSIVE lineage')) {
        assert.deepEqual(values, [80, 3]);
        assert.match(sql, /NOT k.id = ANY\(l.visited\)/);
        return { rows: [{ id: 101 }, { id: 102 }] };
      }
      if (sql.includes('INSERT INTO documents')) {
        if (options.documentFailure) throw new Error('Document snapshot failed');
        return { rows: [{ id: values[4] + 1000 }] };
      }
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { db, pool: { connect: async () => db }, calls, released: () => released };
}

test('sources include only verified matches in another accessible site and expose no identity numbers', async () => {
  const { db } = fixture({ matches: [
    source,
    { ...source, id: 11, site_id: 5 },
    { ...source, id: 12, full_name: 'Other Person' },
    { ...source, id: 13, verified_kyc_case_id: null },
    { ...source, id: 14, phone: '+1 9876543210' },
  ] });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  assert.deepEqual(result, {
    already_verified: false, has_mobile: true,
    sources: [
      { id: 10, site_id: 2, site_name: 'Source site', full_name: 'TEST CLIENT', phone: '+91 98765-43210', verified_at: source.kyc_verified_at, name_matches: true },
      { id: 12, site_id: 2, site_name: 'Source site', full_name: 'Other Person', phone: '+91 98765-43210', verified_at: source.kyc_verified_at, name_matches: false },
    ],
  });
});

test('already verified clients need no source search', async () => {
  const { db, calls } = fixture({ alreadyVerified: true });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  assert.equal(result.already_verified, true);
  assert.deepEqual(result.sources, []);
  assert.equal(calls.length, 3);
});

test('clients without a mobile get a helpful empty lookup', async () => {
  const { db } = fixture({ target: { phone: '' } });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  assert.equal(result.has_mobile, false);
  assert.deepEqual(result.sources, []);
});

for (const options of [{ missing: true }, { denied: true }]) {
  test(`source listing hides unavailable target (${JSON.stringify(options)})`, async () => {
    const { db } = fixture(options);
    await assert.rejects(listMemberKycSources(db, { user, memberId: 22 }), { statusCode: 404 });
  });
}

test('identity matching accepts formatting but rejects missing or conflicting identity', () => {
  assert.doesNotThrow(() => assertMatchingKycIdentity({ ...target, aadhar_no: '111122223333', pan_no: 'abcde1234f' }, source));
  for (const change of [
    { phone: '' }, { full_name: '' }, { phone: '9123456789' }, { full_name: 'Other Person' },
    { aadhar_no: '999922223333' }, { pan_no: 'ABCDE9999F' },
  ]) {
    assert.throws(() => assertMatchingKycIdentity({ ...target, ...change }, source), { statusCode: 409 });
  }
});

test('different registered names on the same mobile are offered for explicit confirmation', async () => {
  const { db } = fixture({ target: { full_name: 'ANUJ GOLIYAN' }, matches: [{ ...source, full_name: 'ANUJ KUMAR (GOLIYAN)', site_name: 'DG ASSOCIATES' }] });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].site_name, 'DG ASSOCIATES');
  assert.equal(result.sources[0].name_matches, false);
});

test('explicitly confirmed same-mobile name variation completes incorporation', async () => {
  const { pool, calls } = fixture({ target: { full_name: 'ANUJ GOLIYAN' }, source: { full_name: 'ANUJ KUMAR (GOLIYAN)' } });
  const result = await incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10, samePersonConfirmed: true });
  assert.equal(result.kyc_reused, true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.ok(calls.find(({ sql }) => sql.includes('UPDATE members')).values.includes('ANUJ KUMAR (GOLIYAN)'));
});

test('confirmation cannot bypass different mobiles, missing names or conflicting identity documents', () => {
  for (const change of [{ phone: '9123456789' }, { phone: '' }, { full_name: '' }, { aadhar_no: '999922223333' }, { pan_no: 'ABCDE9999F' }]) {
    assert.throws(() => assertMatchingKycIdentity({ ...target, ...change }, source, { samePersonConfirmed: true }), { statusCode: 409 });
  }
  assert.throws(() => assertMatchingKycIdentity({ ...target, full_name: 'Other name' }, source, { samePersonConfirmed: 'true' }), { statusCode: 409 });
});

for (const openCase of [false, true]) {
  test(`incorporation ${openCase ? 'completes an open case' : 'creates a case'} and snapshots documents without creating a client`, async () => {
    const { pool, calls, released } = fixture({ openCase });
    const result = await incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10 });
    assert.equal(result.kyc_reused, true);
    assert.equal(result.kyc_case_id, 91);
    assert.equal(result.source_site_name, 'Source site');
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1).sql, 'COMMIT');
    assert.equal(released(), true);
    assert.ok(!calls.some(({ sql }) => /INSERT INTO members/.test(sql)));
    const update = calls.find(({ sql }) => sql.includes('UPDATE members'));
    assert.ok(update.values.includes(source.photo));
    assert.ok(update.values.includes('Verified address'));
    assert.doesNotMatch(update.sql, /site_id =|team =|member_type =/);
    const documentCopies = calls.filter(({ sql }) => sql.includes('INSERT INTO documents'));
    assert.deepEqual(documentCopies.map(({ values }) => values), [[91, 22, 5, 7, 101], [91, 22, 5, 7, 102]]);
    assert.match(documentCopies[0].sql, /original_name, file_path, file_hash/);
    const ocrCopies = calls.filter(({ sql }) => sql.includes('INSERT INTO ocr_results'));
    assert.deepEqual(ocrCopies.map(({ values }) => values), [[1101, 101], [1102, 102]]);
    assert.ok(calls.some(({ values }) => values?.[0] === 'accounts-member-kyc-member:22'));
  });
}

test('repeated incorporation leaves already verified target and documents untouched', async () => {
  const { pool, calls } = fixture({ alreadyVerified: true });
  const result = await incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10 });
  assert.equal(result.kyc_reused, false);
  assert.equal(result.kyc_case_id, 77);
  assert.ok(!calls.some(({ sql }) => /UPDATE members|INSERT INTO|UPDATE kyc_cases/.test(sql)));
});

for (const [options, statusCode] of [
  [{ denied: true }, 404], [{ unavailable: true }, 409], [{ changed: true }, 409],
  [{ source: { full_name: 'Other Person' } }, 409],
  [{ target: { aadhar_no: '999922223333' } }, 409],
]) {
  test(`incorporation rejects stale or conflicting records and rolls back (${JSON.stringify(options)})`, async () => {
    const { pool, calls, released } = fixture(options);
    await assert.rejects(incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10 }), { statusCode });
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.equal(released(), true);
    assert.ok(!calls.some(({ sql }) => /UPDATE members|INSERT INTO|UPDATE kyc_cases/.test(sql)));
  });
}

test('document failures roll back the profile and case together', async () => {
  const { pool, calls, released } = fixture({ documentFailure: true });
  await assert.rejects(incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10 }), /Document snapshot failed/);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.equal(released(), true);
  assert.ok(!calls.some(({ sql }) => sql === 'COMMIT'));
});

test('invalid source ids are rejected before opening a transaction', async () => {
  const { pool, calls } = fixture();
  for (const sourceMemberId of [null, -1, 'abc', 1.5, 22]) {
    await assert.rejects(incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId }), { statusCode: 400 });
  }
  assert.deepEqual(calls, []);
});
