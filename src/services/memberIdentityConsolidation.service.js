import { memberModel } from '../models/Member.model.js';
import { MEMBER_FIELDS, DOC_FIELDS } from './memberProfileFields.js';
import { shareVerifiedCase } from './memberSiteSharing.service.js';

const fail = message => { throw Object.assign(new Error(message), { statusCode: 409, code: 'MEMBER_MERGE_CONFLICT' }); };
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const identity = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Retained aliases let existing profile/ledger URLs open the surviving member. */
export async function resolveMemberIdentityId(db, memberId, user) {
  const { rows: [schema] } = await db.query("SELECT to_regclass('public.member_identity_aliases') AS aliases");
  if (!schema.aliases) return memberId;
  const { rows: [alias] } = await db.query(`SELECT canonical_member_id FROM member_identity_aliases
    WHERE member_id=$1 AND organization_id=$2`, [memberId, user.organization_id]);
  return alias?.canonical_member_id || memberId;
}

/** Caller owns a transaction and the organisation directory lock. Only explicitly
 * selected registrations are consolidated, with one member retained per site.
 * Every referencing record keeps its ID, site, amount and verification history. */
export async function consolidateMemberRegistrations(db, { memberIds, sourceMemberId, profileMemberId, user, originalProfiles = [] }) {
  const { rows: members } = await db.query(`SELECT m.* FROM members m JOIN sites s ON s.id=m.site_id
    WHERE m.id=ANY($1::int[]) AND s.organization_id=$2 ORDER BY m.site_id,m.id FOR UPDATE OF m`,
  [memberIds, user.organization_id]);
  if (members.length !== new Set(memberIds).size) fail('Some selected registrations are no longer available. Review the identities again.');
  for (const field of ['aadhar_no', 'pan_no']) {
    if (new Set(members.map(member => identity(member[field])).filter(Boolean)).size > 1) fail('The selected registrations have different Aadhaar or PAN numbers.');
  }
  const { rows: cases } = await db.query(`SELECT id,client_member_id,verified_by,verified_at FROM kyc_cases
    WHERE client_member_id=ANY($1::int[]) AND status='VERIFIED'
    ORDER BY verified_at DESC NULLS LAST,id DESC FOR SHARE`, [memberIds]);
  const verifiedIds = new Set(cases.map(row => row.client_member_id));
  const bySite = new Map();
  for (const member of members) bySite.set(member.site_id, [...(bySite.get(member.site_id) || []), member]);
  const mapping = new Map();
  const canonical = [];
  for (const registrations of bySite.values()) {
    const survivor = registrations.find(member => member.id === Number(sourceMemberId))
      || registrations.find(member => member.id === Number(profileMemberId))
      || registrations.find(member => verifiedIds.has(member.id)) || registrations[0];
    canonical.push(survivor);
    for (const member of registrations) mapping.set(member.id, survivor.id);
    if (registrations.length < 2) continue;
    const patch = {};
    for (const field of [...MEMBER_FIELDS, ...DOC_FIELDS]) {
      if (survivor[field] == null || survivor[field] === '') {
        const value = registrations.find(member => member[field] != null && member[field] !== '')?.[field];
        if (value !== undefined) patch[field] = value;
      }
    }
    const roles = [...new Set(registrations.flatMap(member => member.member_types || [member.member_type]).filter(Boolean))];
    patch.member_types = roles;
    patch.member_type = survivor.member_type || roles[0];
    const notes = [...new Set(registrations.map(member => member.notes?.trim()).filter(Boolean))];
    if (notes.length) patch.notes = notes.join('\n\n');
    await memberModel.update(survivor.id, { ...patch, updated_at: new Date() }, db);
  }

  // Inspect actual installed FKs, including newer modules. Never guess which
  // "user", "farmer" or "client" IDs refer to members rather than other tables.
  const { rows: foreignKeys } = await db.query(`SELECT DISTINCT ns.nspname AS schema_name,
    tbl.relname AS table_name,attr.attname AS column_name
    FROM pg_constraint c JOIN pg_class tbl ON tbl.oid=c.conrelid
    JOIN pg_namespace ns ON ns.oid=tbl.relnamespace
    JOIN pg_attribute attr ON attr.attrelid=c.conrelid AND attr.attnum=c.conkey[1]
    WHERE c.contype='f' AND c.confrelid='members'::regclass AND array_length(c.conkey,1)=1
    ORDER BY schema_name,table_name,column_name`);
  // These member links intentionally have no FK in older installations.
  const { rows: optionalLinks } = await db.query(`SELECT table_schema AS schema_name,table_name,column_name,data_type
    FROM information_schema.columns WHERE table_schema='public' AND
    (column_name='tds_member_id' AND data_type='integer'
      OR table_name='plot_registries' AND column_name IN
        ('noc_client_member_ids','noc_farmer_member_ids','noc_authorized_member_ids') AND data_type='ARRAY')`);
  const links = [...foreignKeys, ...optionalLinks.filter(optional => !foreignKeys.some(fk =>
    fk.schema_name === optional.schema_name && fk.table_name === optional.table_name && fk.column_name === optional.column_name))];
  const mergedIds = members.filter(member => mapping.get(member.id) !== member.id).map(member => member.id);
  for (const oldId of mergedIds) {
    const survivorId = mapping.get(oldId);
    const linkedRecords = {};
    for (const link of links) {
      const table = `${quote(link.schema_name)}.${quote(link.table_name)}`;
      const column = quote(link.column_name);
      try {
        const result = link.data_type === 'ARRAY'
          ? await db.query(`UPDATE ${table} SET ${column}=ARRAY(SELECT value
              FROM unnest(array_replace(${column},$1::int,$2::int)) WITH ORDINALITY entry(value,position)
              GROUP BY value ORDER BY MIN(position))
              WHERE $1::int=ANY(${column})`, [oldId, survivorId])
          : await db.query(`UPDATE ${table} SET ${column}=$2 WHERE ${column}=$1`, [oldId, survivorId]);
        if (result.rowCount) linkedRecords[`${link.table_name}.${link.column_name}`] = result.rowCount;
      } catch (error) {
        if (error.code === '23505') fail(`These registrations have overlapping records in ${link.table_name}. Review those records before merging; no changes were saved.`);
        throw error;
      }
    }
    const original = originalProfiles.find(member => member.id === oldId) || members.find(member => member.id === oldId);
    await db.query(`INSERT INTO member_identity_aliases
      (member_id,canonical_member_id,organization_id,site_id,merged_by,member_snapshot,linked_records)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [oldId,survivorId,user.organization_id,original.site_id,user.id,JSON.stringify(original),JSON.stringify(linkedRecords)]);
    await db.query('DELETE FROM members WHERE id=$1', [oldId]);
  }

  // Carry forward an actual verification, never manufacture verification from
  // completed fields. Case/document IDs moved above remain valid audit sources.
  const sourceCase = cases.find(row => row.client_member_id === Number(profileMemberId)) || cases[0];
  let kycSharedCount = 0;
  if (sourceCase) {
    const sourceId = mapping.get(sourceCase.client_member_id);
    const { rows: [source] } = await db.query('SELECT * FROM members WHERE id=$1', [sourceId]);
    Object.assign(source, { verified_kyc_case_id: sourceCase.id,
      kyc_verified_by: sourceCase.verified_by, kyc_verified_at: sourceCase.verified_at });
    for (const target of canonical) {
      if (target.id !== sourceId && await shareVerifiedCase(db, { source, target: { ...target, ...source, id: target.id, site_id: target.site_id }, user })) kycSharedCount++;
    }
  }
  return { merged_count: mergedIds.length, merged_member_ids: mergedIds,
    canonical_member_id: mapping.get(Number(sourceMemberId)), canonical_member_ids: canonical.map(member => member.id),
    kyc_shared_count: kycSharedCount };
}
