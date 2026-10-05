import assert from 'node:assert/strict';
import pool from '../config/db.js';
import { up as migrate } from '../migrations/194_member_identity_consolidation.js';
import { lockMemberDirectory } from '../services/memberSiteSharing.service.js';
import { consolidateMemberRegistrations } from '../services/memberIdentityConsolidation.service.js';
import { findMemberPlots } from '../services/plotMemberLinks.service.js';

// Repair an already confirmed shared identity. Default is a full dry run with
// rollback. No name/phone matching, amounts, or unrelated identities are changed.
const args = process.argv.slice(2);
const idArgument = name => {
  const value = Number(args[args.indexOf(name) + 1]);
  if (!args.includes(name) || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Provide ${name} with a valid ID.`);
  return value;
};
const quote = value => `"${value.replaceAll('"','""')}"`;

try {
  const memberId = idArgument('--member-id');
  const duplicateId = idArgument('--duplicate-id');
  const userId = idArgument('--user-id');
  assert.notEqual(memberId, duplicateId);
  await migrate(pool);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    const { rows: [user] } = await db.query(`SELECT id,role,organization_id FROM users
      WHERE id=$1 AND role IN ('admin','super_admin') AND is_active=true`,[userId]);
    assert.ok(user,'An active administrator is required.');
    await lockMemberDirectory(db,user);
    const { rows: members } = await db.query(`SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id
      WHERE m.id=ANY($1::int[]) AND s.organization_id=$2 ORDER BY m.id FOR UPDATE OF m`,
    [[memberId,duplicateId],user.organization_id]);
    assert.equal(members.length,2,'Both selected registrations must be available.');
    assert.ok(members[0].shared_profile_id,'Review and link the identity before using this repair.');
    assert.equal(members[0].shared_profile_id,members[1].shared_profile_id,'Only an already linked identity can be repaired.');
    assert.equal(members[0].site_id,members[1].site_id,'The duplicate must belong to the same site.');

    const { rows: links } = await db.query(`SELECT DISTINCT tbl.relname AS table_name,attr.attname AS column_name
      FROM pg_constraint c JOIN pg_class tbl ON tbl.oid=c.conrelid
      JOIN pg_attribute attr ON attr.attrelid=c.conrelid AND attr.attnum=c.conkey[1]
      WHERE c.contype='f' AND c.confrelid='members'::regclass AND tbl.relname<>'member_identity_aliases'
      UNION SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
        AND (column_name='tds_member_id' OR table_name='plot_registries' AND column_name IN
          ('noc_client_member_ids','noc_farmer_member_ids','noc_authorized_member_ids'))`);
    const tables = new Map();
    for (const link of links) tables.set(link.table_name,[...(tables.get(link.table_name)||[]),link.column_name]);
    const fingerprints = async () => {
      const result = {};
      for (const [table,columns] of tables) {
        const where = columns.map(column => column.endsWith('_ids')
          ? `${quote(column)} && $1::int[]` : `${quote(column)}=ANY($1::int[])`).join(' OR ');
        const { rows: [row] } = await db.query(`SELECT count(*)::int AS count,
          md5(COALESCE(jsonb_agg(to_jsonb(t)-$2::text[] ORDER BY (to_jsonb(t)-$2::text[])::text)::text,'[]')) AS digest
          FROM ${quote(table)} t WHERE ${where}`,[[memberId,duplicateId],columns]);
        result[table] = row;
      }
      return result;
    };
    const before = await fingerprints();
    const plotLinksBefore = await findMemberPlots(members[0].site_id,db);
    const expectedPlots = [...new Set([...(plotLinksBefore.get(String(memberId))||[]),
      ...(plotLinksBefore.get(String(duplicateId))||[])].map(plot => plot.id))];
    const result = await consolidateMemberRegistrations(db,{memberIds:[memberId,duplicateId],
      sourceMemberId:memberId,profileMemberId:duplicateId,user,originalProfiles:members});
    assert.deepEqual(await fingerprints(),before,'Related record IDs, amounts and all non-member fields must remain intact.');
    const plotLinksAfter = await findMemberPlots(members[0].site_id,db);
    const afterPlots = plotLinksAfter.get(String(memberId))||[];
    assert.ok(expectedPlots.every(id => afterPlots.some(plot => plot.id===id)),'Every existing plot must follow the survivor.');
    const { rows: [verification] } = await db.query(`SELECT count(*)::int AS verified_cases
      FROM kyc_cases WHERE client_member_id=$1 AND status='VERIFIED'`,[memberId]);
    await db.query(args.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({applied:args.includes('--apply'),...result,plots:afterPlots.map(plot=>plot.plot_no),
      verified_cases:verification.verified_cases,related_records_unchanged:true},null,2));
  } catch (error) {await db.query('ROLLBACK');throw error;}
  finally {db.release();}
} catch (error) {console.error(error.message);process.exitCode=1;}
finally {await pool.end();}
