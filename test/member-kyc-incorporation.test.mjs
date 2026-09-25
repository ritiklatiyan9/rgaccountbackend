import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMatchingKycIdentity, incorporateMemberKyc, listMemberKycSources, parseKycSourceQuery,
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
        assert.match(sql, /m.id = \$2/);
        assert.match(sql, /m.site_id <> \$3/);
        assert.deepEqual(values, [3, 10, 5, false, 7]);
        return { rows: options.unavailable ? [] : [{ ...source, ...options.source }] };
      }
      if (sql.includes('s.name AS site_name')) {
        if (options.noTrigram && sql.includes('similarity(')) throw Object.assign(new Error('function similarity does not exist'), { code: '42883' });
        return { rows: options.matches || [source] };
      }
      if (sql.includes('WHERE site_id = $1 AND id <> $2')) return { rows: options.mobileTaken ? [{ id: 30, full_name: 'OTHER HOLDER' }] : [] };
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

const searchCall = (calls) => calls.find(({ sql }) => sql.includes('s.name AS site_name'));
const profileUpdate = (calls) => calls.find(({ sql }) => sql.includes('UPDATE members'));
const updatedValue = (calls, field) => {
  const update = profileUpdate(calls);
  const index = update.sql.match(new RegExp(`\\b${field} = \\$(\\d+)`))?.[1];
  return index ? update.values[Number(index) - 1] : undefined;
};

test('search text is read as a mobile (full or partial) or a name, defaulting to this registration', () => {
  assert.deepEqual(parseKycSourceQuery('', target), { mode: 'phone', value: '9876543210' });
  assert.deepEqual(parseKycSourceQuery('', { full_name: 'Akash Sharma' }), { mode: 'name', value: 'AKASHSHARMA', text: 'Akash Sharma' });
  assert.deepEqual(parseKycSourceQuery('+91 98765-43210', target), { mode: 'phone', value: '9876543210' });
  assert.deepEqual(parseKycSourceQuery(' 6409 ', target), { mode: 'phone', value: '6409' });
  assert.equal(parseKycSourceQuery('12', target).mode, 'none');
  assert.deepEqual(parseKycSourceQuery('Sourav  Malik', target), { mode: 'name', value: 'SOURAVMALIK', text: 'Sourav  Malik' });
  assert.equal(parseKycSourceQuery('ab', target).mode, 'none');
  assert.equal(parseKycSourceQuery('', {}).mode, 'none');
});

test('mobile search lists verified sources first and explains unverified matches without identity numbers', async () => {
  const { db, calls } = fixture({ matches: [
    { ...source, id: 12, full_name: 'Other Person', phone: '9000000001' },
    { ...source, id: 11, full_name: 'Other Person' },
    source,
    { ...source, id: 13, verified_kyc_case_id: null, kyc_verified_at: null },
    { ...source, id: 22 },
  ] });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  const search = searchCall(calls);
  assert.match(search.sql, /m.site_id <> \$2/);
  assert.match(search.sql, /s.organization_id = \$1/);
  assert.match(search.sql, /permitted_site.site_id = s.id/);
  assert.match(search.sql, /m.alt_phone/);
  assert.deepEqual(search.values, [3, 5, false, 7, '9876543210']);

  assert.equal(result.already_verified, false);
  assert.equal(result.has_mobile, true);
  assert.deepEqual(result.query, { mode: 'phone', value: '9876543210' });
  assert.deepEqual(result.sources.map(({ id }) => id), [10, 11, 12]);
  assert.deepEqual(result.sources[0], {
    id: 10, site_id: 2, site_name: 'Source site', full_name: 'TEST CLIENT', father_name: '', city: '',
    phone: '+91 98765-43210', photo: source.photo, verified_at: source.kyc_verified_at,
    name_matches: true, mobile_matches: true, identity_conflict: null,
  });
  assert.equal(result.sources[1].name_matches, false);
  assert.equal(result.sources[2].mobile_matches, false);
  assert.deepEqual(result.others.map(({ id }) => id), [13]);
  for (const row of [...result.sources, ...result.others]) {
    assert.ok(!('aadhar_no' in row) && !('pan_no' in row) && !('verified_kyc_case_id' in row));
  }
});

test('conflicting Aadhaar/PAN is flagged in the search result', async () => {
  const { db } = fixture({ target: { pan_no: 'ZZZZZ9999Z' } });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  assert.equal(result.sources[0].identity_conflict, 'PAN');
});

test('name search tolerates spelling and falls back to substring search without pg_trgm', async () => {
  const { db, calls } = fixture();
  await listMemberKycSources(db, { user, memberId: 22, query: 'Akash Sharma' });
  assert.match(searchCall(calls).sql, /similarity\(UPPER\(m.full_name\), UPPER\(\$6\)\)/);
  assert.deepEqual(searchCall(calls).values, [3, 5, false, 7, 'AKASHSHARMA', 'Akash Sharma']);

  const fallback = fixture({ noTrigram: true });
  const result = await listMemberKycSources(fallback.db, { user, memberId: 22, query: 'Akash Sharma' });
  const searches = fallback.calls.filter(({ sql }) => sql.includes('s.name AS site_name'));
  assert.equal(searches.length, 2);
  assert.doesNotMatch(searches[1].sql, /similarity\(/);
  assert.deepEqual(searches[1].values, [3, 5, false, 7, 'AKASHSHARMA']);
  assert.equal(result.sources.length, 1);
});

test('already verified clients need no source search', async () => {
  const { db, calls } = fixture({ alreadyVerified: true });
  const result = await listMemberKycSources(db, { user, memberId: 22, query: 'Test Client' });
  assert.equal(result.already_verified, true);
  assert.deepEqual(result.sources, []);
  assert.equal(calls.length, 3);
});

test('clients without a mobile are searched by their name', async () => {
  const { db, calls } = fixture({ target: { phone: '' } });
  const result = await listMemberKycSources(db, { user, memberId: 22 });
  assert.equal(result.has_mobile, false);
  assert.deepEqual(result.query, { mode: 'name', value: 'TESTCLIENT' });
  assert.equal(result.sources[0].mobile_matches, false);
  assert.ok(searchCall(calls));
});

test('too-short searches return nothing without querying', async () => {
  const { db, calls } = fixture();
  const result = await listMemberKycSources(db, { user, memberId: 22, query: '98' });
  assert.equal(result.query.mode, 'none');
  assert.deepEqual(result.sources, []);
  assert.equal(searchCall(calls), undefined);
});

for (const options of [{ missing: true }, { denied: true }]) {
  test(`source listing hides unavailable target (${JSON.stringify(options)})`, async () => {
    const { db } = fixture(options);
    await assert.rejects(listMemberKycSources(db, { user, memberId: 22 }), { statusCode: 404 });
  });
}

test('same mobile and name incorporate directly; any other link needs confirmation', () => {
  assert.doesNotThrow(() => assertMatchingKycIdentity({ ...target, aadhar_no: '111122223333', pan_no: 'abcde1234f' }, source));
  for (const change of [{ phone: '' }, { phone: '9123456789' }, { full_name: 'Other Person' }]) {
    assert.throws(() => assertMatchingKycIdentity({ ...target, ...change }, source), { statusCode: 409 });
    assert.doesNotThrow(() => assertMatchingKycIdentity({ ...target, ...change }, source, { samePersonConfirmed: true }));
  }
  assert.throws(() => assertMatchingKycIdentity({ ...target, full_name: 'Other name' }, source, { samePersonConfirmed: 'true' }), { statusCode: 409 });
});

test('confirmation cannot bypass missing names or conflicting identity documents', () => {
  for (const change of [{ full_name: '' }, { aadhar_no: '999922223333' }, { pan_no: 'ABCDE9999F' }]) {
    assert.throws(() => assertMatchingKycIdentity({ ...target, ...change }, source, { samePersonConfirmed: true }), { statusCode: 409 });
  }
  assert.throws(() => assertMatchingKycIdentity(target, { ...source, full_name: ' ' }, { samePersonConfirmed: true }), { statusCode: 409 });
});

test('explicitly confirmed same-mobile name variation completes incorporation', async () => {
  const { pool, calls } = fixture({ target: { full_name: 'ANUJ GOLIYAN' }, source: { full_name: 'ANUJ KUMAR (GOLIYAN)' } });
  const result = await incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10, samePersonConfirmed: true });
  assert.equal(result.kyc_reused, true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.equal(updatedValue(calls, 'full_name'), 'ANUJ KUMAR (GOLIYAN)');
  assert.equal(updatedValue(calls, 'alt_phone'), undefined);
});

test('confirmed different mobile adopts the verified one and keeps the old number as alternate', async () => {
  const { pool, calls } = fixture({ target: { phone: '9000000001' } });
  const result = await incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10, samePersonConfirmed: true });
  assert.equal(result.kyc_reused, true);
  assert.equal(updatedValue(calls, 'phone'), '9876543210');
  assert.equal(updatedValue(calls, 'alt_phone'), '9000000001');
  assert.ok(calls.some(({ values }) => values?.[0] === 'accounts-member-phone:5:9876543210'));
  assert.deepEqual(calls.find(({ sql }) => sql.includes('WHERE site_id = $1 AND id <> $2')).values, [5, 22, '9876543210']);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('a registration without a mobile receives the verified mobile once confirmed', async () => {
  const { pool, calls } = fixture({ target: { phone: null } });
  await incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10, samePersonConfirmed: true });
  assert.equal(updatedValue(calls, 'phone'), '9876543210');
  assert.equal(updatedValue(calls, 'alt_phone'), undefined);
});

test('the verified mobile cannot duplicate another registration in the same site', async () => {
  const { pool, calls, released } = fixture({ target: { phone: '' }, mobileTaken: true });
  await assert.rejects(
    incorporateMemberKyc(pool, { user, memberId: 22, sourceMemberId: 10, samePersonConfirmed: true }),
    { statusCode: 409, message: /already registered to OTHER HOLDER/ },
  );
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.equal(released(), true);
  assert.ok(!calls.some(({ sql }) => /UPDATE members|INSERT INTO|UPDATE kyc_cases/.test(sql)));
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
    const update = profileUpdate(calls);
    assert.ok(update.values.includes(source.photo));
    assert.ok(update.values.includes('Verified address'));
    assert.doesNotMatch(update.sql, /site_id =|team =|member_type =/);
    // The mobile is unchanged, so no second phone lock or duplicate check runs.
    assert.ok(!calls.some(({ sql }) => sql.includes('WHERE site_id = $1 AND id <> $2')));
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
  [{ target: { phone: '9000000001' } }, 409],
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
