import { createHash, randomUUID } from 'node:crypto';
import { memberModel } from '../models/Member.model.js';
import { DOC_FIELDS } from './memberProfileFields.js';
import { assertMemberSiteAccess, normalizeMemberPhone, REUSABLE_KYC_PROFILE_FIELDS } from './memberPhoneReuse.service.js';

const sharedFields = [...new Set([...REUSABLE_KYC_PROFILE_FIELDS, ...DOC_FIELDS])];
const fail = (message, statusCode = 409, code = 'MEMBER_IDENTITY_CONFLICT') => {
  throw Object.assign(new Error(message), { statusCode, code });
};
const identity = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const snapshot = member => Object.fromEntries(
  ['id', 'site_id', 'shared_profile_id', 'updated_at', 'verified_kyc_case_id', ...sharedFields].map(field => [field, member[field] ?? null]),
);

/** Caller holds the directory lock when writing. Include every linked copy of
 * each matching registration, even if a copy still has an old name or mobile. */
export async function reviewMemberIdentity(db, { memberId, user, phone, aadharNo, panNo, lock = false }) {
  const { rows: [source] } = await db.query(`SELECT m.*,s.name AS site_name FROM members m
    JOIN sites s ON s.id=m.site_id WHERE m.id=$1 AND s.organization_id=$2`, [memberId, user.organization_id]);
  if (!source || !await assertMemberSiteAccess(db, user, source.site_id)) fail('This user is unavailable to your account.', 403);
  const normalizedPhone = normalizeMemberPhone(phone ?? source.phone);
  if (phone && !normalizedPhone) fail('Enter a complete 10-digit mobile number.', 400);
  const { rows: registrations } = await db.query(`WITH RECURSIVE matched AS (
      SELECT m.id,m.shared_profile_id FROM members m JOIN sites s ON s.id=m.site_id
      WHERE s.organization_id=$1 AND (m.id=$2
        OR ($3<>'' AND RIGHT(REGEXP_REPLACE(COALESCE(m.phone,''),'[^0-9]','','g'),10)=$3)
        OR ($4<>'' AND UPPER(REGEXP_REPLACE(COALESCE(m.aadhar_no,''),'[^A-Za-z0-9]','','g'))=$4)
        OR ($5<>'' AND UPPER(REGEXP_REPLACE(COALESCE(m.pan_no,''),'[^A-Za-z0-9]','','g'))=$5))
      UNION
      SELECT m.id,m.shared_profile_id FROM members m JOIN sites s ON s.id=m.site_id
      JOIN matched previous ON m.shared_profile_id=previous.shared_profile_id
      WHERE s.organization_id=$1
    ) SELECT m.*,s.name AS site_name, k.id AS verified_kyc_case_id
      FROM members m JOIN matched ON matched.id=m.id JOIN sites s ON s.id=m.site_id
      LEFT JOIN LATERAL (SELECT id FROM kyc_cases WHERE client_member_id=m.id AND status='VERIFIED'
        ORDER BY verified_at DESC NULLS LAST,id DESC LIMIT 1) k ON true
      ORDER BY m.site_id,m.id ${lock ? 'FOR UPDATE OF m' : ''}`,
    [user.organization_id, memberId, normalizedPhone, identity(aadharNo ?? source.aadhar_no), identity(panNo ?? source.pan_no)]);
  const needsLinking = registrations.some(row => row.id !== source.id
    && (!source.shared_profile_id || row.shared_profile_id !== source.shared_profile_id));
  // Do not expose or change registrations beyond the actor's site assignments.
  let unavailable = false;
  for (const siteId of new Set(registrations.map(row => row.site_id))) {
    if (!await assertMemberSiteAccess(db, user, siteId)) unavailable = true;
  }
  const blockedReason = unavailable ? 'An administrator with access to all affected sites must link these identities.'
    : ['aadhar_no', 'pan_no'].some(field => new Set(registrations.map(row => identity(row[field])).filter(Boolean)).size > 1)
      ? 'These registrations have different Aadhaar or PAN numbers. Correct those details before confirming they are the same person.' : null;
  const visible = unavailable ? registrations.filter(row => row.id === source.id) : registrations;
  const revision = createHash('sha256').update(JSON.stringify(registrations.map(snapshot))).digest('hex');
  return { source, registrations, summary: {
    needs_linking: needsLinking, blocked_reason: blockedReason, revision,
    site_count: new Set(visible.map(row => row.site_id)).size,
    registrations: visible.map(row => ({
      id: row.id, site_id: row.site_id, site_name: row.site_name, full_name: row.full_name,
      phone: row.phone, email: row.email, member_types: row.member_types || [row.member_type],
      kyc_verified: Boolean(row.verified_kyc_case_id),
    })),
  } };
}

/** Link registrations; never delete members, move transactions or change roles.
 * The selected profile supplies KYC; the submitted name/mobile are authoritative.
 * All work, including the history record, is committed with the user's edit. */
export async function linkMemberIdentity(db, { review, user, profileMemberId, revision, data }) {
  if (review.summary.blocked_reason) fail(review.summary.blocked_reason);
  if (revision !== review.summary.revision) fail('The registrations changed. Review the identities again before saving.', 409, 'IDENTITY_REVIEW_CHANGED');
  const profile = review.registrations.find(row => Number(row.id) === Number(profileMemberId));
  if (!profile) fail('Choose a profile from the reviewed registrations.', 400);
  const group = review.source.shared_profile_id || profile.shared_profile_id || randomUUID();
  // A sparse registration must not erase documents/details present elsewhere.
  const preferred = [profile, ...review.registrations.filter(row => row.id !== profile.id)];
  const shared = {};
  for (const field of sharedFields) {
    const value = preferred.find(row => row[field] != null && row[field] !== '')?.[field];
    if (value !== undefined) shared[field] = value;
  }
  for (const field of ['full_name', 'phone', ...DOC_FIELDS]) {
    if (data[field] !== undefined) shared[field] = data[field];
  }
  for (const field of ['email', 'co_applicant_name', 'co_applicant_relation', 'co_applicant_phone', 'co_applicant_aadhar', 'co_applicant_pan']) {
    // The short form echoes empty co-applicant inputs even if untouched.
    // Only an actual edit overrides the chosen profile's existing KYC.
    if (data[field] !== undefined && (data[field] ?? '') !== (review.source[field] ?? '')) shared[field] = data[field];
  }
  if (!shared.full_name?.trim()) fail('A full name is required.', 400);
  const before = review.registrations.map(snapshot);
  const updatedAt = new Date();
  for (const member of review.registrations) {
    await memberModel.update(member.id, { ...shared, shared_profile_id: group, updated_at: updatedAt }, db);
  }
  // The normal update runs after this. Use the chosen profile for hidden KYC
  // fields rather than the stale values echoed by the short Edit User form.
  for (const field of sharedFields) delete data[field];
  Object.assign(data, shared);
  const after = review.registrations.map(member => snapshot({ ...member, ...shared, shared_profile_id: group, updated_at: updatedAt }));
  await db.query(`INSERT INTO member_identity_link_events
    (organization_id,member_id,user_id,shared_profile_id,profiles_before,profiles_after)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [user.organization_id, review.source.id, user.id, group, JSON.stringify(before), JSON.stringify(after)]);
  return { shared_profile_id: group, registration_count: review.registrations.length, site_count: review.summary.site_count };
}
