const FIELDS = ['co_applicant_name', 'co_applicant_relation', 'co_applicant_phone', 'co_applicant_aadhar', 'co_applicant_pan'];
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const text = (value, max, label, upper = false) => {
  if (value != null && !['string', 'number'].includes(typeof value)) fail(`${label} must be text`);
  const out = String(value ?? '').trim();
  if (out.length > max) fail(`${label} is too long`);
  return upper ? out.toUpperCase() : out;
};
export function plotCoApplicants(plot = {}) {
  let rows = plot.co_applicants;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { rows = []; } }
  if (Array.isArray(rows) && rows.length) return rows;
  return FIELDS.some(field => String(plot[field] || '').trim()) ? [{
    member_id: null, full_name: plot.co_applicant_name || '', relation: plot.co_applicant_relation || '',
    phone: plot.co_applicant_phone || '', aadhar_no: plot.co_applicant_aadhar || '', pan_no: plot.co_applicant_pan || '',
  }] : [];
}
export function assertBuyerNotCoApplicant(plot, buyerMemberId) {
  if (buyerMemberId != null && plotCoApplicants(plot).some(person => person.member_id != null && Number(person.member_id) === Number(buyerMemberId))) fail('The primary buyer cannot also be a co-applicant');
}
export function coApplicantLegacyFields(rows) {
  const first = rows[0] || {};
  return Object.fromEntries(FIELDS.map((field, index) => [field,
    first[['full_name', 'relation', 'phone', 'aadhar_no', 'pan_no'][index]] || null]));
}

export async function effectivePlotBuyerMember(db, siteId, existing = {}, body = {}) {
  if (Object.hasOwn(body, 'buyer_member_id') && body.buyer_member_id != null) return Number(body.buyer_member_id);
  const buyerNameChanged = Object.hasOwn(body, 'buyer_name') && String(body.buyer_name || '').trim().toUpperCase() !== String(existing.buyer_name || '').trim().toUpperCase();
  if (existing.buyer_member_id != null && !buyerNameChanged) return Number(existing.buyer_member_id);
  if (existing.id && !buyerNameChanged) {
    const { PLOT_BUYER_MEMBER_JOIN } = await import('./plotMemberLinks.service.js');
    return (await db.query(`SELECT plot_buyer.id FROM plots p ${PLOT_BUYER_MEMBER_JOIN} WHERE p.id=$1 AND p.site_id=$2`, [existing.id, siteId])).rows[0]?.id ?? null;
  }
  const buyerName = body.buyer_name ?? existing.buyer_name;
  if (!String(buyerName || '').trim()) return null;
  return (await db.query(`SELECT CASE WHEN COUNT(*)=1 THEN MIN(id) END AS id FROM members WHERE site_id=$1 AND UPPER(BTRIM(full_name))=UPPER(BTRIM($2))`, [siteId, buyerName])).rows[0]?.id ?? null;
}

/** Normalize a complete draft while retaining additional people when an older UI edits the first one. */
export async function coApplicantsForWrite(body, siteId, db, { existing = {}, buyerMemberId = existing.buyer_member_id } = {}) {
  const explicit = Object.hasOwn(body, 'co_applicants');
  const needsBuyerCheck = (explicit ? body.co_applicants : plotCoApplicants(existing));
  if (buyerMemberId == null && Array.isArray(needsBuyerCheck) && needsBuyerCheck.some(row => row?.member_id != null)) buyerMemberId = await effectivePlotBuyerMember(db, siteId, existing, body);
  if (!explicit && !FIELDS.some(field => Object.hasOwn(body, field))) { assertBuyerNotCoApplicant(existing, buyerMemberId); return {}; }
  let draft;
  if (explicit) {
    if (!Array.isArray(body.co_applicants)) fail('Co-applicants must be a list; use an empty list to remove them');
    draft = body.co_applicants;
  } else {
    const current = plotCoApplicants(existing);
    const first = { ...(current[0] || {}), ...Object.fromEntries(FIELDS.map((field, index) => [
      ['full_name', 'relation', 'phone', 'aadhar_no', 'pan_no'][index], Object.hasOwn(body, field) ? body[field] : existing[field] ?? current[0]?.[['full_name', 'relation', 'phone', 'aadhar_no', 'pan_no'][index]],
    ])) };
    if (Object.hasOwn(body, 'co_applicant_name') && String(body.co_applicant_name || '').trim().toUpperCase() !== String(current[0]?.full_name || '').trim().toUpperCase()) first.member_id = null;
    draft = [...(Object.values(first).some(value => value != null && value !== '') ? [first] : []), ...current.slice(1)];
  }
  if (draft.length > 50) fail('A plot can have at most 50 co-applicants');
  const seen = new Set();
  const rows = draft.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`Co-applicant ${index + 1} is invalid`);
    let id = row.member_id;
    if (id == null || id === '') id = null;
    else {
      if (!['string', 'number'].includes(typeof id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) fail(`Select a valid user for co-applicant ${index + 1}`);
      id = Number(id);
      if (id === Number(buyerMemberId)) fail('The primary buyer cannot also be a co-applicant');
      if (seen.has(id)) fail('Add each co-applicant only once');
      seen.add(id);
    }
    return { member_id: id, full_name: text(row.full_name, 255, 'Co-applicant name', true), relation: text(row.relation, 100, 'Relationship'),
      phone: text(row.phone, 32, 'Co-applicant phone'), aadhar_no: text(row.aadhar_no ?? row.aadhar, 32, 'Co-applicant Aadhaar'),
      pan_no: text(row.pan_no ?? row.pan, 20, 'Co-applicant PAN', true) };
  });
  const ids = [...seen];
  const members = ids.length ? (await db.query('SELECT id, full_name, phone, aadhar_no, pan_no FROM members WHERE site_id=$1 AND id=ANY($2::int[])', [siteId, ids])).rows : [];
  const byId = new Map(members.map(member => [Number(member.id), member]));
  for (const row of rows) {
    if (row.member_id) {
      const member = byId.get(row.member_id);
      if (!member) fail('Select co-applicants registered in the same site as this plot');
      row.full_name = member.full_name;
      row.phone = member.phone || '';
      row.aadhar_no = member.aadhar_no || '';
      row.pan_no = member.pan_no || '';
    }
    if (!row.full_name) {
      const unchangedLegacy = row.member_id == null && plotCoApplicants(existing).some(previous => !previous.member_id && !String(previous.full_name || '').trim()
        && ['relation','phone','aadhar_no','pan_no'].every(field => String(previous[field] || '').trim().toUpperCase() === String(row[field] || '').trim().toUpperCase()));
      if (!unchangedLegacy) fail('Enter a name or select a user for every co-applicant');
    }
  }
  return { co_applicants: JSON.stringify(rows), ...coApplicantLegacyFields(rows) };
}

// to_jsonb permits read-only fallbacks while a deployment still awaits migration 245.
export const PLOT_CO_APPLICANTS_SOURCE = `CASE WHEN jsonb_typeof(to_jsonb(p)->'co_applicants')='array'
  AND jsonb_array_length(to_jsonb(p)->'co_applicants')>0 THEN to_jsonb(p)->'co_applicants'
  WHEN COALESCE(NULLIF(BTRIM(to_jsonb(p)->>'co_applicant_name'),''),NULLIF(BTRIM(to_jsonb(p)->>'co_applicant_relation'),''),NULLIF(BTRIM(to_jsonb(p)->>'co_applicant_phone'),''),NULLIF(BTRIM(to_jsonb(p)->>'co_applicant_aadhar'),''),NULLIF(BTRIM(to_jsonb(p)->>'co_applicant_pan'),'')) IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
    'member_id',NULL,'full_name',to_jsonb(p)->>'co_applicant_name','relation',to_jsonb(p)->>'co_applicant_relation','phone',to_jsonb(p)->>'co_applicant_phone',
    'aadhar_no',to_jsonb(p)->>'co_applicant_aadhar','pan_no',to_jsonb(p)->>'co_applicant_pan')) ELSE '[]'::jsonb END`;
export const PLOT_CO_APPLICANTS_SELECT = `COALESCE(plot_co.co_applicants,'[]'::jsonb) AS co_applicants`;
export const PLOT_CO_APPLICANTS_JOIN = `LEFT JOIN LATERAL (
  SELECT jsonb_agg(entry.value || CASE WHEN co_member.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'full_name',(to_jsonb(co_member)->>'full_name'),'phone',(to_jsonb(co_member)->>'phone'),'aadhar_no',(to_jsonb(co_member)->>'aadhar_no'),'pan_no',(to_jsonb(co_member)->>'pan_no')) END
    || jsonb_build_object('member_id',co_member.id,'kyc_status',CASE
    WHEN co_member.id IS NULL THEN 'UNLINKED'
    WHEN co_kyc.status IS NOT NULL THEN co_kyc.status
    WHEN COALESCE(NULLIF((to_jsonb(co_member)->>'phone'),''),NULLIF((to_jsonb(co_member)->>'email'),'')) IS NOT NULL
      AND COALESCE(NULLIF((to_jsonb(co_member)->>'address'),''),NULLIF((to_jsonb(co_member)->>'city'),'')) IS NOT NULL
      AND COALESCE(NULLIF((to_jsonb(co_member)->>'aadhar_no'),''),NULLIF((to_jsonb(co_member)->>'pan_no'),''),NULLIF((to_jsonb(co_member)->>'voter_id'),''),NULLIF((to_jsonb(co_member)->>'passport_no'),''),NULLIF((to_jsonb(co_member)->>'driving_license_no'),'')) IS NOT NULL
      AND COALESCE(NULLIF((to_jsonb(co_member)->>'aadhar_front_url'),''),NULLIF((to_jsonb(co_member)->>'aadhar_back_url'),''),NULLIF((to_jsonb(co_member)->>'pan_card_url'),''),NULLIF((to_jsonb(co_member)->>'voter_id_url'),''),NULLIF((to_jsonb(co_member)->>'passport_url'),''),NULLIF((to_jsonb(co_member)->>'driving_license_url'),''),NULLIF((to_jsonb(co_member)->>'cheque_url'),''),NULLIF((to_jsonb(co_member)->>'other_kyc_url'),'')) IS NOT NULL THEN 'COMPLETE'
    ELSE 'INCOMPLETE' END) ORDER BY entry.ordinality) AS co_applicants
  FROM jsonb_array_elements(${PLOT_CO_APPLICANTS_SOURCE}) WITH ORDINALITY AS entry(value,ordinality)
  LEFT JOIN members co_member ON co_member.id=CASE WHEN entry.value->>'member_id' ~ '^[0-9]{1,9}$' THEN (entry.value->>'member_id')::int END AND co_member.site_id=p.site_id
  LEFT JOIN LATERAL (SELECT k.status FROM kyc_cases k WHERE k.client_member_id=co_member.id AND k.site_id=p.site_id
    ORDER BY CASE k.status WHEN 'VERIFIED' THEN 4 WHEN 'OCR_DONE' THEN 3 WHEN 'OCR_PENDING' THEN 2 ELSE 1 END DESC,k.updated_at DESC NULLS LAST,k.id DESC LIMIT 1) co_kyc ON true
) plot_co ON true`;
