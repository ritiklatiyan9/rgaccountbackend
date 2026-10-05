import { createHash, randomUUID } from 'node:crypto';
import { memberModel } from '../models/Member.model.js';
import { DOC_FIELDS } from './memberProfileFields.js';
import { assertMemberSiteAccess, normalizeMemberPhone, REUSABLE_KYC_PROFILE_FIELDS } from './memberPhoneReuse.service.js';
import { consolidateMemberRegistrations } from './memberIdentityConsolidation.service.js';
import { relatedIdentityName } from './memberIdentityNameMatch.js';

const sharedFields = [...new Set([...REUSABLE_KYC_PROFILE_FIELDS, ...DOC_FIELDS])];
const fail = (message, statusCode = 409, code = 'MEMBER_IDENTITY_CONFLICT') => {
  throw Object.assign(new Error(message), { statusCode, code });
};
const identity = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const snapshot = member => Object.fromEntries(
  ['id', 'site_id', 'shared_profile_id', 'updated_at', 'verified_kyc_case_id', ...sharedFields].map(field => [field, member[field] ?? null]),
);

/** Caller holds the directory lock when writing. Suggestions use the entered
 * name/mobile; shared document placeholders must not pull in unrelated people. */
export async function reviewMemberIdentity(db, { memberId, user, phone, fullName, lock = false }) {
  const { rows: [source] } = await db.query(`SELECT m.*,s.name AS site_name FROM members m
    JOIN sites s ON s.id=m.site_id WHERE m.id=$1 AND s.organization_id=$2`, [memberId, user.organization_id]);
  if (!source || !await assertMemberSiteAccess(db, user, source.site_id)) fail('This user is unavailable to your account.', 403);
  const normalizedPhone = normalizeMemberPhone(phone ?? source.phone);
  if (phone && !normalizedPhone) fail('Enter a complete 10-digit mobile number.', 400);
  const reviewName = String(fullName ?? source.full_name).trim();
  const { rows: directory } = await db.query(`SELECT m.id,m.site_id,m.full_name,m.phone,m.shared_profile_id
    FROM members m JOIN sites s ON s.id=m.site_id WHERE s.organization_id=$1`, [user.organization_id]);
  const matching = directory.filter((row) => row.id === source.id
    || (normalizedPhone && normalizeMemberPhone(row.phone) === normalizedPhone)
    || relatedIdentityName(row.full_name, reviewName, {
      allowInitials: Boolean(source.shared_profile_id && row.shared_profile_id === source.shared_profile_id),
    }));
  const { rows: registrations } = await db.query(`SELECT m.*,s.name AS site_name, k.id AS verified_kyc_case_id
      FROM members m JOIN sites s ON s.id=m.site_id
      LEFT JOIN LATERAL (SELECT id FROM kyc_cases WHERE client_member_id=m.id AND status='VERIFIED'
        ORDER BY verified_at DESC NULLS LAST,id DESC LIMIT 1) k ON true
      WHERE m.id=ANY($1::int[]) AND s.organization_id=$2
      ORDER BY m.site_id,m.id ${lock ? 'FOR UPDATE OF m' : ''}`,
    [matching.map((row) => row.id), user.organization_id]);
  const needsLinking = registrations.some(row => row.id !== source.id
    && (!source.shared_profile_id || row.shared_profile_id !== source.shared_profile_id));
  // Do not expose or change registrations beyond the actor's site assignments.
  let unavailable = false;
  for (const siteId of new Set(registrations.map(row => row.site_id))) {
    if (!await assertMemberSiteAccess(db, user, siteId)) unavailable = true;
  }
  const blockedReason = unavailable ? 'An administrator with access to all affected sites must link these identities.' : null;
  const visible = unavailable ? registrations.filter(row => row.id === source.id) : registrations;
  const conflicts = [];
  for (let i = 0; i < visible.length; i++) {
    for (const other of visible.slice(i + 1)) {
      for (const field of ['aadhar_no', 'pan_no']) {
        if (identity(visible[i][field]) && identity(other[field]) && identity(visible[i][field]) !== identity(other[field])) {
          conflicts.push({ member_ids: [visible[i].id, other.id], field: field === 'pan_no' ? 'PAN' : 'Aadhaar' });
        }
      }
    }
  }
  const revision = createHash('sha256').update(JSON.stringify(registrations.map(snapshot))).digest('hex');
  return { source, registrations, summary: {
    needs_linking: needsLinking, blocked_reason: blockedReason, revision,
    selection_supported: true, source_member_id: source.id, identity_conflicts: conflicts,
    match_criteria: { full_name: reviewName, phone: normalizedPhone },
    site_count: new Set(visible.map(row => row.site_id)).size,
    registrations: visible.map(row => ({
      id: row.id, site_id: row.site_id, site_name: row.site_name, full_name: row.full_name,
      phone: row.phone, email: row.email, member_types: row.member_types || [row.member_type],
      kyc_verified: Boolean(row.verified_kyc_case_id),
      match_reason: row.id === source.id ? 'SOURCE'
        : normalizedPhone && normalizeMemberPhone(row.phone) === normalizedPhone ? 'PHONE' : 'NAME',
    })),
  } };
}

/** Link selected identities and consolidate duplicate registrations within a site.
 * The selected profile supplies KYC; the submitted name/mobile are authoritative.
 * All work, including the history record, is committed with the user's edit. */
export async function linkMemberIdentity(db, { review, user, profileMemberId, selectedMemberIds, revision, data }) {
  if (review.summary.blocked_reason) fail(review.summary.blocked_reason);
  if (revision !== review.summary.revision) fail('The registrations changed. Review the identities again before saving.', 409, 'IDENTITY_REVIEW_CHANGED');
  let ids = selectedMemberIds;
  if (typeof ids === 'string') {
    try { ids = JSON.parse(ids); } catch { fail('Select valid registrations to link.', 400); }
  }
  if (!Array.isArray(ids) || ids.some(id => !['number', 'string'].includes(typeof id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    fail('Select valid registrations to link.', 400);
  }
  const selectedIds = new Set(ids.map(Number));
  if (selectedIds.size < 2) fail('Select at least two registrations to link.', 400);
  if (!selectedIds.has(Number(review.source.id))) fail('Include the user you are editing in the selection.', 400);
  const selected = review.registrations.filter(row => selectedIds.has(Number(row.id)));
  if (selected.length !== selectedIds.size) fail('Some selected registrations are unavailable. Review the list again.', 400);
  const profile = selected.find(row => Number(row.id) === Number(profileMemberId));
  if (!profile) fail('Choose a KYC profile from the selected registrations.', 400);
  if (['aadhar_no', 'pan_no'].some(field => new Set(selected.map(row => identity(row[field])).filter(Boolean)).size > 1)) {
    fail('The selected registrations have different Aadhaar or PAN numbers. Correct those details before confirming they are the same person.');
  }
  // Reusing a group with unchecked members would silently include those people
  // in subsequent edits. Detach the selected registrations into a fresh group
  // whenever neither preferred existing group contains only selected records.
  const candidates = [review.source.shared_profile_id, profile.shared_profile_id].filter(Boolean);
  const { rows: eligibleGroups } = candidates.length ? await db.query(`SELECT DISTINCT m.shared_profile_id FROM members m
    WHERE m.shared_profile_id=ANY($1::uuid[]) AND NOT EXISTS (
      SELECT 1 FROM members remaining WHERE remaining.shared_profile_id=m.shared_profile_id AND NOT (remaining.id=ANY($2::int[]))
    )`, [candidates, [...selectedIds]]) : { rows: [] };
  const eligible = new Set(eligibleGroups.map((row) => row.shared_profile_id));
  const group = candidates.find((groupId) => eligible.has(groupId)) || randomUUID();
  // A sparse registration must not erase documents/details present elsewhere.
  const preferred = [profile, ...selected.filter(row => row.id !== profile.id)];
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
  const before = selected.map(snapshot);
  const updatedAt = new Date();
  for (const member of selected) {
    await memberModel.update(member.id, { ...shared, shared_profile_id: group, updated_at: updatedAt }, db);
  }
  // Use the chosen profile for hidden KYC fields rather than the stale values
  // echoed by the short Edit User form.
  for (const field of sharedFields) delete data[field];
  Object.assign(data, shared);
  // Apply the edited site's fields before consolidation. Its role selection and
  // short-form blanks must not overwrite roles/notes recovered from duplicates.
  await memberModel.update(review.source.id, data, db);
  const after = selected.map(member => snapshot({ ...member, ...shared, shared_profile_id: group, updated_at: updatedAt }));
  await db.query(`INSERT INTO member_identity_link_events
    (organization_id,member_id,user_id,shared_profile_id,profiles_before,profiles_after)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [user.organization_id, review.source.id, user.id, group, JSON.stringify(before), JSON.stringify(after)]);
  const consolidation = await consolidateMemberRegistrations(db, { memberIds: selected.map(row => row.id),
    sourceMemberId: review.source.id, profileMemberId: profile.id, user, originalProfiles: selected });
  return { ...consolidation, shared_profile_id: group, registration_count: selected.length,
    member_ids: selected.map(row => row.id), site_count: new Set(selected.map(row => row.site_id)).size };
}
