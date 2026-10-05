import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { MEMBER_FIELDS, DOC_FIELDS } from '../src/services/memberProfileFields.js';
import { memberModel } from '../src/models/Member.model.js';
import { reviewMemberIdentity } from '../src/services/memberIdentityLink.service.js';
import { lockMemberDirectory, registerMemberAcrossSites } from '../src/services/memberSiteSharing.service.js';
import { updateMember } from '../src/controllers/member.controller.js';
import { up as sharingMigration } from '../src/migrations/187_member_site_sharing.js';
import { up as linkingMigration } from '../src/migrations/192_member_identity_linking.js';

const actor = { id: 7, role: 'admin', organization_id: 1 };
async function fixture(t) {
  const sql = new PGlite();
  t.after(() => sql.close());
  const fields = [...new Set([...MEMBER_FIELDS, ...DOC_FIELDS, 'geocode_source', 'geocode_precision', 'geocoded_at'])];
  await sql.exec(`CREATE TABLE sites(id INTEGER PRIMARY KEY,name TEXT,organization_id INTEGER);
    INSERT INTO sites VALUES(1,'Defence Garden',1),(2,'Other Site',1),(3,'Different organisation',2);
    CREATE TABLE user_sites(user_id INTEGER,site_id INTEGER); INSERT INTO user_sites VALUES(8,1);
    CREATE TABLE app_schema_migrations(version TEXT PRIMARY KEY);
    CREATE TABLE members(id SERIAL PRIMARY KEY,site_id INTEGER REFERENCES sites(id),member_types TEXT[],created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),
      ${fields.map(field => `${field} ${['latitude', 'longitude'].includes(field) ? 'NUMERIC' : field === 'geocoded_at' ? 'TIMESTAMPTZ' : 'TEXT'}`).join(',')});
    CREATE TABLE kyc_cases(id SERIAL PRIMARY KEY,client_member_id INTEGER REFERENCES members(id),site_id INTEGER,
      status TEXT,verified_at TIMESTAMPTZ,verified_by INTEGER);
    CREATE TABLE plots(id INTEGER PRIMARY KEY,site_id INTEGER,buyer_member_id INTEGER REFERENCES members(id),updated_at TIMESTAMPTZ);
    CREATE TABLE payments(id INTEGER PRIMARY KEY,site_id INTEGER,member_id INTEGER REFERENCES members(id),amount NUMERIC);
    CREATE TABLE ledgers(id INTEGER PRIMARY KEY,site_id INTEGER,member_id INTEGER REFERENCES members(id),opening NUMERIC);`);
  const query = async (text, values) => { const r = await sql.query(text, values); return { ...r, rowCount: r.affectedRows }; };
  const db = { query, release() {} };
  const localPool = { query, connect: async () => db };
  await sharingMigration(localPool); await linkingMigration(localPool); await linkingMigration(localPool);
  const previous = { query: pool.query, connect: pool.connect };
  pool.query = query; pool.connect = localPool.connect;
  t.after(() => { pool.query = previous.query; pool.connect = previous.connect; });
  const add = changes => memberModel.create({ site_id: 1, full_name: 'RAHUL TOMAR', phone: '9000000000',
    member_type: 'PARTNER', member_types: ['PARTNER'], status: 'ACTIVE', ...changes }, db);
  return { db, query, add };
}
function update(id, body, user = actor) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
    updateMember({ params: { id }, body, user }, res, reject);
  });
}
async function reviewedBody(db, memberId, changes = {}, user = actor) {
  const body = { phone: '9897659617', full_name: 'RAHUL TOMAR', ...changes };
  const review = await reviewMemberIdentity(db, { memberId, user, phone: body.phone });
  return { ...body, same_person_confirmed: 'true', identity_profile_member_id: memberId,
    identity_member_ids: review.registrations.map(row => row.id), identity_revision: review.summary.revision };
}

test('different names and two shared groups become one identity; all registration and financial links survive', async t => {
  const { db, query, add } = await fixture(t);
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  const a = await add({ shared_profile_id: first });
  const a2 = await add({ site_id: 2, shared_profile_id: first, phone: '9000000000', full_name: 'RAHUL T', member_type: 'BROKER', member_types: ['BROKER'], notes: 'BROKER NOTE' });
  const b = await add({ shared_profile_id: second, full_name: 'RAHUL KUMAR TOMAR', phone: '9897659617', aadhar_front_url: 'kyc/rahul.jpg' });
  const b2 = await add({ site_id: 2, shared_profile_id: second, full_name: 'RAHUL KUMAR TOMAR', phone: '9897659617', member_type: 'FARMER', member_types: ['FARMER'] });
  await query('INSERT INTO plots VALUES(1,1,$1,now()),(2,2,$2,now())', [b.id, a2.id]);
  await query('INSERT INTO payments VALUES(1,1,$1,123.45),(2,2,$2,678.90)', [b.id, b2.id]);
  await query('INSERT INTO ledgers VALUES(1,1,$1,-123.45),(2,2,$2,777.77)', [a.id, b2.id]);
  const before = await Promise.all(['plots', 'payments', 'ledgers'].map(table => query(`SELECT * FROM ${table} ORDER BY id`)));
  const body = await reviewedBody(db, a.id, { member_types: 'PARTNER,CLIENT' });
  const result = await update(a.id, body);
  assert.equal(result.status, 200); assert.equal(result.data.identity_link.registration_count, 4);
  const members = (await query('SELECT * FROM members ORDER BY id')).rows;
  assert.equal(members.length, 4); assert.equal(new Set(members.map(row => row.shared_profile_id)).size, 1);
  assert.ok(members.every(row => row.full_name === 'RAHUL TOMAR' && row.phone === '9897659617' && row.aadhar_front_url === 'kyc/rahul.jpg'));
  assert.deepEqual(members[0].member_types, ['PARTNER', 'CLIENT']);
  assert.deepEqual(members[1].member_types, ['BROKER']); assert.equal(members[1].notes, 'BROKER NOTE');
  assert.deepEqual(members[3].member_types, ['FARMER']);
  const after = await Promise.all(['plots', 'payments', 'ledgers'].map(table => query(`SELECT * FROM ${table} ORDER BY id`)));
  assert.deepEqual(after.map(r => r.rows), before.map(r => r.rows));
  const event = (await query('SELECT * FROM member_identity_link_events')).rows[0];
  assert.equal(event.user_id, actor.id); assert.equal(event.profiles_before.find(row => row.id === b.id).full_name, 'RAHUL KUMAR TOMAR');
  assert.equal(event.profiles_after.find(row => row.id === b.id).full_name, 'RAHUL TOMAR');
  assert.equal((await update(a.id, { full_name: 'RAHUL KUMAR TOMAR', phone: '9897659618' })).status, 200);
  assert.ok((await query('SELECT phone FROM members')).rows.every(row => row.phone === '9897659618'));
});

test('an unconfirmed duplicate edit is still blocked and does not change any identity', async t => {
  const { query, add } = await fixture(t);
  const source = await add(); await add({ full_name: 'RAHUL KUMAR TOMAR', phone: '9897659617' });
  const result = await update(source.id, { phone: '9897659617' });
  assert.equal(result.status, 409); assert.equal(result.data.code, 'MEMBER_IDENTITY_CONFLICT');
  assert.equal((await query('SELECT phone FROM members WHERE id=$1', [source.id])).rows[0].phone, '9000000000');
  assert.equal((await query('SELECT count(*)::int AS n FROM member_identity_link_events')).rows[0].n, 0);
});

test('the selected profile supplies KYC without promoting unverified cases', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add({ address: 'OLD ADDRESS' });
  const b = await add({ site_id: 2, full_name: 'RAHUL KUMAR TOMAR', phone: '+91 98976 59617', address: 'REVIEWED ADDRESS', pan_no: 'ABCDE1234F', co_applicant_name: 'CO APPLICANT' });
  await query("INSERT INTO kyc_cases(client_member_id,site_id,status,verified_at,verified_by) VALUES($1,2,'VERIFIED',now(),7)", [b.id]);
  const cases = (await query('SELECT * FROM kyc_cases')).rows;
  const body = await reviewedBody(db, a.id, { address: 'OLD ADDRESS', co_applicant_name: '' }); body.identity_profile_member_id = b.id;
  assert.equal((await update(a.id, body)).status, 200);
  assert.ok((await query('SELECT address,pan_no FROM members')).rows.every(row => row.address === 'REVIEWED ADDRESS' && row.pan_no === 'ABCDE1234F'));
  assert.deepEqual((await query('SELECT * FROM kyc_cases')).rows, cases);
  assert.ok((await query('SELECT co_applicant_name FROM members')).rows.every(row => row.co_applicant_name === 'CO APPLICANT'));
});

test('a changed review or a newly added matching registration requires a fresh confirmation', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add(); await add({ site_id: 2, full_name: 'RAHUL KUMAR TOMAR', phone: '9897659617' });
  const body = await reviewedBody(db, a.id);
  await add({ phone: '9897659617', full_name: 'ANOTHER REGISTRATION' });
  await assert.rejects(update(a.id, body), { code: 'IDENTITY_REVIEW_CHANGED' });
  assert.ok((await query('SELECT shared_profile_id FROM members')).rows.every(row => row.shared_profile_id === null));
});

test('different government identities cannot be linked just because the phone matches', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add({ pan_no: 'ABCDE1234F' }); await add({ phone: '9897659617', pan_no: 'VWXYZ1234F' });
  const body = await reviewedBody(db, a.id);
  await assert.rejects(update(a.id, body), /different Aadhaar or PAN/);
  assert.ok((await query('SELECT shared_profile_id FROM members')).rows.every(row => row.shared_profile_id === null));
});

test('other organisations are excluded and restricted site users cannot expose or link inaccessible copies', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add(); await add({ site_id: 2, phone: '9897659617' });
  const other = await add({ site_id: 3, phone: '9897659617' });
  const user = { id: 8, role: 'sub_admin', organization_id: 1 };
  const { summary } = await reviewMemberIdentity(db, { memberId: a.id, user, phone: '9897659617' });
  assert.match(summary.blocked_reason, /administrator/); assert.deepEqual(summary.registrations.map(row => row.id), [a.id]);
  await assert.rejects(update(a.id, await reviewedBody(db, a.id, {}, user), user), /administrator/);
  assert.equal((await update(a.id, await reviewedBody(db, a.id))).status, 200);
  assert.equal((await query('SELECT shared_profile_id FROM members WHERE id=$1', [other.id])).rows[0].shared_profile_id, null);
});

test('a failure after linking rolls back profiles, groups and history together', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add(); await add({ phone: '9897659617' });
  const body = await reviewedBody(db, a.id, { plot_id: 999 });
  await assert.rejects(update(a.id, body), /plot from this user/);
  assert.ok((await query('SELECT shared_profile_id FROM members')).rows.every(row => row.shared_profile_id === null));
  assert.equal((await query('SELECT count(*)::int AS n FROM member_identity_link_events')).rows[0].n, 0);
  assert.equal((await query('SELECT phone FROM members WHERE id=$1', [a.id])).rows[0].phone, '9000000000');
});

test('registering an explicitly linked identity again accepts same-site legacy registrations without adding copies', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add(); await add({ phone: '9897659617' }); await add({ site_id: 2, phone: '9897659617' });
  await update(a.id, await reviewedBody(db, a.id));
  await query('BEGIN');
  try {
    await lockMemberDirectory(db, actor);
    const result = await registerMemberAcrossSites(db, { memberId: a.id, user: actor });
    assert.equal(result.created_count, 0); await query('COMMIT');
  } catch (error) { await query('ROLLBACK'); throw error; }
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n, 3);
  await query("INSERT INTO sites VALUES(5,'New Site',1)");
  const newSource = await add({ site_id: 5, phone: '9897659617' });
  await query('BEGIN');
  try {
    await lockMemberDirectory(db, actor);
    const result = await registerMemberAcrossSites(db, { memberId: newSource.id, user: actor });
    assert.equal(result.created_count, 0); await query('COMMIT');
  } catch (error) { await query('ROLLBACK'); throw error; }
  assert.equal((await query('SELECT count(DISTINCT shared_profile_id)::int AS n FROM members')).rows[0].n, 1);
});

test('only selected registrations are linked and old groups do not absorb unchecked copies on later edits', async t => {
  const { db, query, add } = await fixture(t);
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  const a = await add({ shared_profile_id: first });
  const excludedA = await add({ site_id: 2, shared_profile_id: first, full_name: 'OLD RAHUL NAME', address: 'EXCLUDED ADDRESS' });
  const b = await add({ site_id: 2, shared_profile_id: second, phone: '9897659617', full_name: 'RAHUL KUMAR TOMAR' });
  const excludedB = await add({ shared_profile_id: second, phone: '9897659617', full_name: 'EXCLUDED RAHUL', aadhar_front_url: 'excluded/document.jpg' });
  const untouched = (await query('SELECT * FROM members WHERE id=ANY($1::int[]) ORDER BY id', [[excludedA.id, excludedB.id]])).rows;
  const body = await reviewedBody(db, a.id);
  body.identity_member_ids = JSON.stringify([a.id, b.id]); body.identity_profile_member_id = b.id;
  const result = await update(a.id, body);
  assert.equal(result.status, 200); assert.equal(result.data.identity_link.registration_count, 2);
  assert.deepEqual(result.data.identity_link.member_ids, [a.id, b.id]);
  assert.notEqual(result.data.identity_link.shared_profile_id, first); assert.notEqual(result.data.identity_link.shared_profile_id, second);
  assert.equal((await query('SELECT aadhar_front_url FROM members WHERE id=$1', [a.id])).rows[0].aadhar_front_url, null);
  assert.deepEqual((await query('SELECT * FROM members WHERE id=ANY($1::int[]) ORDER BY id', [[excludedA.id, excludedB.id]])).rows, untouched);
  assert.equal((await update(a.id, { full_name: 'NEW SHARED NAME', phone: '9897659617' })).status, 200);
  assert.equal((await query('SELECT full_name FROM members WHERE id=$1', [b.id])).rows[0].full_name, 'NEW SHARED NAME');
  assert.deepEqual((await query('SELECT * FROM members WHERE id=ANY($1::int[]) ORDER BY id', [[excludedA.id, excludedB.id]])).rows, untouched);
  const event = (await query('SELECT * FROM member_identity_link_events')).rows[0];
  assert.deepEqual(event.profiles_before.map(row => row.id), [a.id, b.id]);
});

test('an unchecked matching mobile with different government identity does not block or contaminate the selected identity', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add({ pan_no: 'ABCDE1234F' });
  const b = await add({ site_id: 2, phone: '9897659617', pan_no: 'ABCDE1234F' });
  const excluded = await add({ phone: '9897659617', full_name: 'ANOTHER PERSON', pan_no: 'VWXYZ1234F' });
  const before = (await query('SELECT * FROM members WHERE id=$1', [excluded.id])).rows[0];
  const reviewed = await reviewMemberIdentity(db, { memberId: a.id, user: actor, phone: '9897659617' });
  assert.ok(reviewed.summary.identity_conflicts.some(pair => pair.member_ids.includes(excluded.id)));
  const body = await reviewedBody(db, a.id); body.identity_member_ids = [a.id, b.id];
  assert.equal((await update(a.id, body)).status, 200);
  assert.equal((await update(a.id, { full_name: 'EDITED SELECTED PERSON', phone: '9897659617', pan_no: 'ABCDE1234F' })).status, 200);
  assert.deepEqual((await query('SELECT * FROM members WHERE id=$1', [excluded.id])).rows[0], before);
});

test('selection must include the edited user, at least two reviewed members, and the chosen KYC source', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add(); const b = await add({ phone: '9897659617' });
  const c = await add({ site_id: 2, phone: '9897659617' });
  const otherOrg = await add({ site_id: 3, phone: '9897659617' });
  const base = await reviewedBody(db, a.id);
  for (const invalid of [undefined, 'invalid JSON', [a.id], [b.id, c.id], [a.id, otherOrg.id], [a.id, b.id, false]]) {
    await assert.rejects(update(a.id, { ...base, identity_member_ids: invalid }), { statusCode: 400 });
  }
  await assert.rejects(update(a.id, { ...base, identity_member_ids: [a.id, b.id], identity_profile_member_id: c.id }), /selected registrations/);
  assert.equal((await query('SELECT count(*)::int AS n FROM member_identity_link_events')).rows[0].n, 0);
  assert.ok((await query('SELECT shared_profile_id FROM members')).rows.every(row => row.shared_profile_id === null));
});
