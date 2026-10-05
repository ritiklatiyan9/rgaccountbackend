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
import { up as consolidationMigration } from '../src/migrations/194_member_identity_consolidation.js';
import { resolveMemberIdentityId } from '../src/services/memberIdentityConsolidation.service.js';

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
      booking_id INTEGER,mode TEXT,status TEXT,verified_at TIMESTAMPTZ,verified_by INTEGER,created_by INTEGER,
      reused_from_case_id INTEGER REFERENCES kyc_cases(id),created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
    CREATE TABLE documents(id SERIAL PRIMARY KEY,kyc_case_id INTEGER REFERENCES kyc_cases(id),client_member_id INTEGER REFERENCES members(id),
      site_id INTEGER,type TEXT,member_document_field TEXT,original_name TEXT,file_path TEXT,file_hash TEXT,mime_type TEXT,
      file_size BIGINT,ocr_status TEXT,ocr_engine TEXT,ocr_completed_at TIMESTAMPTZ,ocr_error TEXT,uploaded_source TEXT,
      uploaded_by INTEGER,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
    CREATE TABLE ocr_results(id SERIAL PRIMARY KEY,document_id INTEGER REFERENCES documents(id),raw_text TEXT,
      extracted_fields JSONB,confidence_overall NUMERIC,confidence_map JSONB,engine TEXT,processed_at TIMESTAMPTZ);
    CREATE TABLE plot_commissions_v2(id INTEGER PRIMARY KEY,site_id INTEGER,plot_id INTEGER,agent_id INTEGER REFERENCES members(id),amount NUMERIC);
    CREATE TABLE plot_registries(id INTEGER PRIMARY KEY,site_id INTEGER,noc_client_member_ids INTEGER[],noc_authorized_member_ids INTEGER[]);
    CREATE TABLE cash_flow_entries(id INTEGER PRIMARY KEY,tds_member_id INTEGER,amount NUMERIC);
    CREATE TABLE plots(id INTEGER PRIMARY KEY,site_id INTEGER,buyer_member_id INTEGER REFERENCES members(id),updated_at TIMESTAMPTZ);
    CREATE TABLE payments(id INTEGER PRIMARY KEY,site_id INTEGER,member_id INTEGER REFERENCES members(id),amount NUMERIC);
    CREATE TABLE ledgers(id INTEGER PRIMARY KEY,site_id INTEGER,member_id INTEGER REFERENCES members(id),opening NUMERIC);`);
  const query = async (text, values) => { const r = await sql.query(text, values); return { ...r, rowCount: r.affectedRows }; };
  const db = { query, release() {} };
  const localPool = { query, connect: async () => db };
  await sharingMigration(localPool); await linkingMigration(localPool); await linkingMigration(localPool);
  await consolidationMigration(localPool); await consolidationMigration(localPool);
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

test('same-site duplicates become one member, with every financial row and combined roles preserved', async t => {
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
  assert.equal(members.length, 2); assert.equal(new Set(members.map(row => row.shared_profile_id)).size, 1);
  assert.equal(result.data.identity_link.merged_count, 2);
  assert.ok(members.every(row => row.full_name === 'RAHUL TOMAR' && row.phone === '9897659617' && row.aadhar_front_url === 'kyc/rahul.jpg'));
  assert.deepEqual(members[0].member_types, ['PARTNER', 'CLIENT']);
  assert.deepEqual(members[1].member_types, ['BROKER', 'FARMER']); assert.equal(members[1].notes, 'BROKER NOTE');
  const after = await Promise.all(['plots', 'payments', 'ledgers'].map(table => query(`SELECT * FROM ${table} ORDER BY id`)));
  const stripMemberIds = rows => rows.map(({ member_id, buyer_member_id, ...rest }) => rest);
  assert.deepEqual(after.map(r => stripMemberIds(r.rows)), before.map(r => stripMemberIds(r.rows)));
  assert.deepEqual(after[0].rows.map(row => row.buyer_member_id), [a.id, a2.id]);
  assert.deepEqual(after[1].rows.map(row => row.member_id), [a.id, a2.id]);
  assert.deepEqual(after[2].rows.map(row => row.member_id), [a.id, a2.id]);
  assert.equal(await resolveMemberIdentityId(db, b.id, actor), a.id);
  assert.equal(await resolveMemberIdentityId(db, b.id, { ...actor, organization_id: 2 }), b.id);
  const aliases = (await query('SELECT * FROM member_identity_aliases ORDER BY member_id')).rows;
  assert.equal(aliases.length, 2); assert.equal(aliases[0].member_snapshot.full_name, 'RAHUL KUMAR TOMAR');
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

test('review suggestions use the entered phone and related full names, never shared government placeholders or unrelated linked names', async t => {
  const {db,add}=await fixture(t);
  const group='11111111-1111-4111-8111-111111111111';
  const source=await add({full_name:'RAHUL CHAUHAN',phone:'9000000000',aadhar_no:'123456789012',shared_profile_id:group});
  const sameName=await add({site_id:2,full_name:'RAHUL CHAUHAN',phone:'9000000001'});
  const middle=await add({site_id:2,full_name:'RAHUL KUMAR CHAUHAN',phone:'9000000002'});
  const spelling=await add({site_id:2,full_name:'RAHUL CHOUHAN',phone:'9000000003'});
  const enteredPhone=await add({full_name:'RAHUL C',phone:'+91 87918 18929'});
  const unrelated=await add({site_id:2,full_name:'SUBHASH CHOUDHARY',phone:'6396042016',aadhar_no:'123456789012',shared_profile_id:group});
  const oldPhone=await add({site_id:2,full_name:'LOKENDRA SAROHA',phone:'9000000000',aadhar_no:'123456789012'});
  const firstOnly=await add({site_id:2,full_name:'RAHUL TOMAR',phone:'9000000004'});
  const {summary}=await reviewMemberIdentity(db,{memberId:source.id,user:actor,phone:'8791818929',fullName:'RAHUL CHAUHAN'});
  assert.deepEqual(new Set(summary.registrations.map(row=>row.id)),new Set([source.id,sameName.id,middle.id,spelling.id,enteredPhone.id]));
  assert.ok(!summary.registrations.some(row=>[unrelated.id,oldPhone.id,firstOnly.id].includes(row.id)));
  assert.equal(summary.registrations.find(row=>row.id===enteredPhone.id).match_reason,'PHONE');
  assert.equal(summary.registrations.find(row=>row.id===middle.id).match_reason,'NAME');
  assert.deepEqual(summary.match_criteria,{full_name:'RAHUL CHAUHAN',phone:'8791818929'});
  const renamed=await reviewMemberIdentity(db,{memberId:source.id,user:actor,phone:'',fullName:'RAHUL TOMAR'});
  assert.deepEqual(new Set(renamed.summary.registrations.map(row=>row.id)),new Set([source.id,firstOnly.id]));
});

test('a hidden unrelated copy cannot follow an explicitly selected identity or later updates', async t => {
  const {db,query,add}=await fixture(t);
  const group='11111111-1111-4111-8111-111111111111';
  const source=await add({shared_profile_id:group});
  const hidden=await add({site_id:2,full_name:'SUBHASH CHOUDHARY',phone:'9000000001',shared_profile_id:group});
  const selected=await add({site_id:2,phone:'9897659617'});
  const before=(await query('SELECT * FROM members WHERE id=$1',[hidden.id])).rows[0];
  const body=await reviewedBody(db,source.id);
  assert.deepEqual(new Set(body.identity_member_ids),new Set([source.id,selected.id]));
  const result=await update(source.id,body);
  assert.notEqual(result.data.identity_link.shared_profile_id,group);
  await update(source.id,{full_name:'RAHUL TOMAR',phone:'9897659618'});
  assert.deepEqual((await query('SELECT * FROM members WHERE id=$1',[hidden.id])).rows[0],before);
});

test('a selected verified profile supplies audited KYC and documents to other selected sites', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add({ address: 'OLD ADDRESS' });
  const b = await add({ site_id: 2, full_name: 'RAHUL KUMAR TOMAR', phone: '+91 98976 59617', address: 'REVIEWED ADDRESS', pan_no: 'ABCDE1234F', co_applicant_name: 'CO APPLICANT' });
  await query("INSERT INTO kyc_cases(client_member_id,site_id,status,verified_at,verified_by) VALUES($1,2,'VERIFIED',now(),7)", [b.id]);
  const cases = (await query('SELECT * FROM kyc_cases')).rows;
  await query("INSERT INTO documents(kyc_case_id,client_member_id,site_id,type,file_path) VALUES($1,$2,2,'AADHAAR','kyc/verified.jpg')", [cases[0].id,b.id]);
  const body = await reviewedBody(db, a.id, { address: 'OLD ADDRESS', co_applicant_name: '' }); body.identity_profile_member_id = b.id;
  assert.equal((await update(a.id, body)).status, 200);
  assert.ok((await query('SELECT address,pan_no FROM members')).rows.every(row => row.address === 'REVIEWED ADDRESS' && row.pan_no === 'ABCDE1234F'));
  const after = (await query('SELECT * FROM kyc_cases ORDER BY id')).rows;
  assert.deepEqual(after[0], cases[0]);
  assert.equal(after.length, 2); assert.equal(after[1].status, 'VERIFIED');
  assert.equal(after[1].reused_from_case_id, cases[0].id); assert.equal(after[1].client_member_id, a.id);
  assert.equal((await query('SELECT count(*)::int AS n FROM documents')).rows[0].n, 2);
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
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n, 2);
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

test('broker plots, verified history, documents, NOC arrays and non-FK tax links follow the surviving member', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add({ member_type: 'BROKER', member_types: ['BROKER'] });
  const b = await add({ phone: '9897659617', member_type: 'CLIENT', member_types: ['CLIENT'], notes: 'Existing buyer note' });
  const other = await add({ phone: '9888888888', full_name: 'ANOTHER PERSON' });
  const { rows: [kyc] } = await query("INSERT INTO kyc_cases(client_member_id,site_id,status,verified_by,verified_at) VALUES($1,1,'VERIFIED',7,now()) RETURNING *", [b.id]);
  await query("INSERT INTO documents(kyc_case_id,client_member_id,site_id,file_path) VALUES($1,$2,1,'permanent/kyc.jpg')", [kyc.id,b.id]);
  await query('INSERT INTO plot_commissions_v2 VALUES(1,1,101,$1,123.45),(2,1,102,$2,678.90)', [a.id,b.id]);
  await query('INSERT INTO plot_registries VALUES(1,1,$1::int[],$2::int[])', [[other.id,b.id,a.id], [b.id]]);
  await query('INSERT INTO cash_flow_entries VALUES(1,$1,123.45)', [b.id]);
  const body = await reviewedBody(db,a.id,{member_types:'BROKER',notes:''}); body.identity_member_ids = [a.id,b.id]; body.identity_profile_member_id = b.id;
  const result = await update(a.id,body);
  assert.equal(result.data.identity_link.merged_count,1);
  assert.deepEqual(result.data.member.member_types,['BROKER','CLIENT']);
  assert.equal(result.data.member.notes,'Existing buyer note');
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,2);
  assert.deepEqual((await query('SELECT agent_id,amount FROM plot_commissions_v2 ORDER BY id')).rows,
    [{agent_id:a.id,amount:'123.45'},{agent_id:a.id,amount:'678.90'}]);
  const afterCase = (await query('SELECT * FROM kyc_cases')).rows[0];
  assert.deepEqual(afterCase,{...kyc,client_member_id:a.id});
  assert.equal((await query('SELECT client_member_id FROM documents')).rows[0].client_member_id,a.id);
  assert.deepEqual((await query('SELECT noc_client_member_ids,noc_authorized_member_ids FROM plot_registries')).rows[0],
    {noc_client_member_ids:[other.id,a.id],noc_authorized_member_ids:[a.id]});
  assert.deepEqual((await query('SELECT * FROM cash_flow_entries')).rows[0],{id:1,tds_member_id:a.id,amount:'123.45'});
  assert.equal((await update(b.id,{email:'rahul@example.test'})).data.member.id,a.id);
});

test('complete fields and unfinished cases never count as verified without a verified source', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add({ aadhar_no:'123456789012',aadhar_front_url:'kyc/a.jpg',address:'FILLED ADDRESS' });
  const b = await add({ phone:'9897659617' });
  await query("INSERT INTO kyc_cases(client_member_id,site_id,status) VALUES($1,1,'OPEN')",[b.id]);
  await update(a.id,await reviewedBody(db,a.id));
  assert.equal((await query('SELECT count(*)::int AS n FROM members')).rows[0].n,1);
  assert.deepEqual((await query('SELECT client_member_id,status FROM kyc_cases')).rows,[{client_member_id:a.id,status:'OPEN'}]);
});

test('overlapping unique financial relationships roll back the entire merge instead of dropping money or shares', async t => {
  const { db, query, add } = await fixture(t);
  const a = await add(); const b = await add({phone:'9897659617'});
  await query(`CREATE TABLE site_partner_shares(id SERIAL PRIMARY KEY,site_id INTEGER,
    member_id INTEGER REFERENCES members(id),share_pct NUMERIC,UNIQUE(site_id,member_id))`);
  await query('INSERT INTO site_partner_shares(site_id,member_id,share_pct) VALUES(1,$1,10),(1,$2,20)',[a.id,b.id]);
  const before = (await query('SELECT * FROM site_partner_shares ORDER BY id')).rows;
  await assert.rejects(update(a.id,await reviewedBody(db,a.id)),/overlapping records/);
  assert.deepEqual((await query('SELECT * FROM site_partner_shares ORDER BY id')).rows,before);
  assert.equal((await query('SELECT count(*)::int AS n FROM member_identity_aliases')).rows[0].n,0);
  assert.equal((await query('SELECT count(*)::int AS n FROM member_identity_link_events')).rows[0].n,0);
  assert.ok((await query('SELECT shared_profile_id FROM members')).rows.every(row => row.shared_profile_id === null));
});
