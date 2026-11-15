import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrationSql, up, VERSION } from '../src/migrations/245_plot_co_applicants.js';
import { coApplicantsForWrite, plotCoApplicants, effectivePlotBuyerMember, PLOT_CO_APPLICANTS_JOIN, PLOT_CO_APPLICANTS_SELECT } from '../src/services/plotCoApplicants.service.js';
import { linkSelectedMemberPlot } from '../src/services/memberPlotSelection.service.js';
import { nocCoApplicantBlockers, resolveNocCoApplicants } from '../src/services/nocCoApplicants.service.js';

const members = [
  { id: 11, site_id: 5, full_name: 'BUYER', phone: '9876543210', aadhar_no: null, pan_no: null },
  { id: 12, site_id: 5, full_name: 'FIRST PERSON', phone: '9876543211', aadhar_no: '123412341234', pan_no: null },
  { id: 13, site_id: 5, full_name: 'SECOND PERSON', phone: '9876543212', aadhar_no: null, pan_no: 'ABCDE1234F' },
  { id: 14, site_id: 8, full_name: 'OTHER SITE', phone: '9876543213', aadhar_no: null, pan_no: null },
];
const fake = { query: async (_sql, [site, ids]) => ({ rows: members.filter(member => member.site_id === site && ids.includes(member.id)) }) };
const draft = [{ member_id: 12, relation: 'Spouse' }, { member_id: 13, relation: 'Sibling' }];

test('multiple members retain independent identities and first-person legacy fields', async () => {
  const result = await coApplicantsForWrite({ co_applicants: draft }, 5, fake, { buyerMemberId: 11 });
  const rows = JSON.parse(result.co_applicants);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].full_name, 'FIRST PERSON');
  assert.equal(rows[1].pan_no, 'ABCDE1234F');
  assert.equal(result.co_applicant_name, 'FIRST PERSON');
  assert.equal(result.co_applicant_relation, 'Spouse');
  assert.deepEqual(await coApplicantsForWrite({ notes: 'other edit' }, 5, fake), {});
  const cleared = await coApplicantsForWrite({ co_applicants: [] }, 5, fake);
  assert.equal(cleared.co_applicants, '[]');
  assert.equal(cleared.co_applicant_name, null);
});

test('legacy first-person edits retain every additional co-applicant', async () => {
  const current = await coApplicantsForWrite({ co_applicants: draft }, 5, fake);
  const result = await coApplicantsForWrite({ co_applicant_relation: 'Wife' }, 5, fake, { existing: current });
  assert.equal(JSON.parse(result.co_applicants)[0].relation, 'Wife');
  assert.equal(JSON.parse(result.co_applicants)[1].member_id, 13);
  assert.equal(plotCoApplicants({ co_applicant_name: 'OLD PERSON', co_applicant_pan: 'ABCDE1234F' })[0].full_name, 'OLD PERSON');
});

test('rejects malformed drafts, repeated people, buyer duplication and cross-site identities', async () => {
  for (const rows of [null, {}, [null], [{ member_id: true }], [{ member_id: 12 }, { member_id: 12 }], [{ member_id: 11 }], [{ member_id: 14 }], [{ full_name: '' }]]) {
    await assert.rejects(coApplicantsForWrite({ co_applicants: rows }, 5, fake, { buyerMemberId: 11 }), { statusCode: 400 });
  }
});

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE plots(id int PRIMARY KEY, site_id int, buyer_member_id int, buyer_name text, booking_cancelled_at timestamptz,
      updated_at timestamptz DEFAULT now(), co_applicant_name text,co_applicant_relation text,co_applicant_phone text,co_applicant_aadhar text,co_applicant_pan text);
    CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,phone text,email text,address text,city text,
      aadhar_no text,pan_no text,voter_id text,passport_no text,driving_license_no text,
      aadhar_front_url text,aadhar_back_url text,pan_card_url text,voter_id_url text,passport_url text,
      driving_license_url text,cheque_url text,other_kyc_url text);
    CREATE TABLE bookings(id int PRIMARY KEY, site_id int, plot_id int, client_member_id int,status text);
    CREATE TABLE kyc_cases(id int PRIMARY KEY,site_id int,client_member_id int,status text,updated_at timestamptz DEFAULT now());
    INSERT INTO plots(id,site_id,buyer_member_id,buyer_name,co_applicant_name,co_applicant_relation,co_applicant_phone,co_applicant_pan)
      VALUES(20,5,11,'BUYER','LEGACY PERSON','Spouse','9898989898','ABCDE1234F'),(21,5,11,'BUYER',null,null,null,null);
  `);
  for (const member of members) await db.query('INSERT INTO members(id,site_id,full_name,phone,aadhar_no,pan_no) VALUES($1,$2,$3,$4,$5,$6)', Object.values(member));
  await db.exec(`INSERT INTO kyc_cases(id,site_id,client_member_id,status) VALUES(1,5,12,'VERIFIED'),(2,5,13,'OPEN'),(3,8,13,'VERIFIED');`);
  const adapter = { query: (sql, values) => sql === migrationSql && values === undefined ? db.exec(sql) : db.query(sql, values) };
  return { db, adapter, pool: { connect: async () => ({ ...adapter, release() {} }) } };
}

test('additive migration preserves legacy details and is idempotent; joint applicants have independent KYC', async () => {
  const { db, adapter, pool } = await fixture();
  try {
    assert.equal(await up(pool), true);
    assert.equal(await up(pool), false);
    assert.equal((await db.query('SELECT version FROM app_schema_migrations')).rows[0].version, VERSION);
    assert.deepEqual((await db.query('SELECT co_applicants FROM plots WHERE id=20')).rows[0].co_applicants, []);
    assert.equal((await resolveNocCoApplicants(adapter, 5, 20))[0].full_name, 'LEGACY PERSON');
    const data = await coApplicantsForWrite({ co_applicants: draft }, 5, adapter, { buyerMemberId: 11 });
    await db.query('UPDATE plots SET co_applicants=$1,co_applicant_name=$2 WHERE id=21', [data.co_applicants, data.co_applicant_name]);
    const rows = (await db.query(`SELECT ${PLOT_CO_APPLICANTS_SELECT} FROM plots p ${PLOT_CO_APPLICANTS_JOIN} WHERE p.id=21`)).rows[0].co_applicants;
    assert.deepEqual(rows.map(row => [row.member_id, row.kyc_status]), [[12, 'VERIFIED'], [13, 'OPEN']]);
    const people = await resolveNocCoApplicants(adapter, 5, 21);
    assert.equal(people.length, 2);
    assert.deepEqual(nocCoApplicantBlockers(people, true), ['SECOND PERSON: KYC not verified (OPEN)']);
    assert.deepEqual(nocCoApplicantBlockers(people, false), []);
    assert.match(nocCoApplicantBlockers(await resolveNocCoApplicants(adapter, 5, 20), true)[0], /link this co-applicant/);
    await db.exec("UPDATE kyc_cases SET status='VERIFIED' WHERE id=2");
    assert.deepEqual(nocCoApplicantBlockers(await resolveNocCoApplicants(adapter, 5, 21), true), []);
    await assert.rejects(db.query("UPDATE plots SET co_applicants='{}'::jsonb WHERE id=21"));
  } finally { await db.close(); }
});

test('member links append joint applicants without replacing the buyer and preserve cancellation history', async () => {
  const { db, adapter } = await fixture();
  try {
    await db.exec(migrationSql);
    await linkSelectedMemberPlot(adapter, { plotId: 21, memberId: 12, siteId: 5, plotRole: 'co_applicant', relation: 'Spouse' });
    await linkSelectedMemberPlot(adapter, { plotId: 21, memberId: 13, siteId: 5, plotRole: 'co_applicant', relation: 'Sibling' });
    await linkSelectedMemberPlot(adapter, { plotId: 21, memberId: 12, siteId: 5, plotRole: 'co_applicant', relation: 'Wife' });
    const plot = (await db.query('SELECT * FROM plots WHERE id=21')).rows[0];
    assert.equal(plot.buyer_member_id, 11);
    assert.deepEqual(plot.co_applicants.map(row => row.member_id), [12,13]);
    assert.equal(plot.co_applicants[0].relation, 'Wife');
    await assert.rejects(linkSelectedMemberPlot(adapter, { plotId: 21, memberId: 11, siteId: 5, plotRole: 'co_applicant' }), { statusCode: 400 });
    await assert.rejects(linkSelectedMemberPlot(adapter, { plotId: 21, memberId: 14, siteId: 5, plotRole: 'co_applicant' }), { statusCode: 400 });
    await db.exec('UPDATE plots SET booking_cancelled_at=now() WHERE id=21');
    await assert.rejects(linkSelectedMemberPlot(adapter, { plotId: 21, memberId: 12, siteId: 5, plotRole: 'co_applicant' }), { statusCode: 409 });
  } finally { await db.close(); }
});

test('buyer-only edits cannot duplicate a co-applicant, including name-resolved primary buyers', async () => {
  const existing = { buyer_member_id: 11, co_applicants: [{ member_id: 12, full_name: 'FIRST PERSON' }] };
  await assert.rejects(coApplicantsForWrite({ buyer_member_id: 12 }, 5, fake, { existing, buyerMemberId: 12 }), { statusCode: 400 });
  const { db, adapter } = await fixture();
  try {
    await db.exec(migrationSql);
    await db.exec('UPDATE plots SET buyer_member_id=NULL WHERE id=21');
    const plot = (await db.query('SELECT * FROM plots WHERE id=21')).rows[0];
    assert.equal(await effectivePlotBuyerMember(adapter, 5, plot), 11);
    await assert.rejects(coApplicantsForWrite({ co_applicants: [{ member_id: 11 }] }, 5, adapter, { existing: plot }), { statusCode: 400 });
  } finally { await db.close(); }
});

test('canonical member edits, including cleared IDs, reach plot and NOC reads', async () => {
  const { db, adapter } = await fixture();
  try {
    await db.exec(migrationSql);
    const data = await coApplicantsForWrite({ co_applicants: [{ member_id: 12, aadhar_no: 'forged', pan_no: 'forged' }] }, 5, adapter, { buyerMemberId: 11 });
    assert.equal(JSON.parse(data.co_applicants)[0].pan_no, '');
    await db.query('UPDATE plots SET co_applicants=$1 WHERE id=21', [data.co_applicants]);
    await db.exec("UPDATE members SET full_name='UPDATED PERSON',phone=NULL,aadhar_no=NULL,pan_no=NULL WHERE id=12");
    const [person] = await resolveNocCoApplicants(adapter, 5, 21);
    assert.equal(person.full_name, 'UPDATED PERSON');
    assert.equal(person.phone, null);
    assert.equal(person.aadhar_no, null);
    assert.equal(person.pan_no, null);
    assert.equal(person.id_ready, false);
    const write = await coApplicantsForWrite({ co_applicants: [{ member_id: 12, phone: '12345', aadhar_no: 'forged' }] }, 5, adapter, { buyerMemberId: 11 });
    assert.equal(JSON.parse(write.co_applicants)[0].aadhar_no, '');
    assert.equal(JSON.parse(write.co_applicants)[0].phone, '');
  } finally { await db.close(); }
});

test('migration performs no plot data changes, preserving approval state and cancelled history', () => {
  assert.doesNotMatch(migrationSql, /UPDATE\s+plots|DELETE\s+FROM|DISABLE\s+TRIGGER|session_replication_role/i);
});
