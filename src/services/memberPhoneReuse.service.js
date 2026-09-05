const ADMIN_ROLES = new Set(['admin', 'super_admin']);

/** Canonical Indian mobile format used for matching without changing legacy rows. */
export const normalizeMemberPhone = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  return '';
};

export const normalizeMemberName = (value) => String(value || '')
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

export const REUSABLE_KYC_PROFILE_FIELDS = [
  'full_name', 'father_name', 'mother_name', 'spouse_name', 'gender', 'date_of_birth',
  'blood_group', 'nationality', 'religion', 'caste', 'marital_status',
  'anniversary_date', 'qualification',
  'phone', 'alt_phone', 'email', 'whatsapp',
  'address', 'permanent_address', 'city', 'state', 'pincode',
  'latitude', 'longitude', 'village', 'district', 'geocode_source',
  'geocode_precision', 'geocoded_at',
  'aadhar_no', 'pan_no', 'voter_id', 'passport_no', 'driving_license_no',
  'gst_no', 'tin_no',
  'bank_name', 'account_no', 'ifsc_code', 'branch',
  'occupation', 'company_name',
  'emergency_contact_name', 'emergency_contact_phone', 'emergency_contact_relation',
  'nominee_name', 'nominee_relation', 'nominee_phone',
  'co_applicant_name', 'co_applicant_relation', 'co_applicant_dob',
  'co_applicant_gender', 'co_applicant_phone', 'co_applicant_email',
  'co_applicant_aadhar', 'co_applicant_pan', 'co_applicant_address',
  'photo', 'aadhar_front_url', 'aadhar_back_url', 'pan_card_url',
  'voter_id_url', 'passport_url', 'driving_license_url', 'cheque_url', 'other_kyc_url',
];

/**
 * Verified identity fields win over retyped values. Site-specific categories,
 * teams, status and notes stay with the new registration.
 */
export const mergeVerifiedKycProfile = (submitted, source) => {
  const merged = { ...submitted };
  for (const field of REUSABLE_KYC_PROFILE_FIELDS) {
    if (source?.[field] !== undefined && source[field] !== null && source[field] !== '') {
      merged[field] = source[field];
    }
  }
  const normalizedPhone = normalizeMemberPhone(source?.phone || submitted?.phone);
  if (normalizedPhone) merged.phone = normalizedPhone;
  return merged;
};

const siteAccessSql = (siteAlias = 's') => `AND ($4::boolean OR EXISTS (
       SELECT 1 FROM user_sites permitted_site
        WHERE permitted_site.user_id = $5 AND permitted_site.site_id = ${siteAlias}.id
     ))`;

export const assertMemberSiteAccess = async (db, user, siteId) => {
  const { rows } = await db.query(
    `SELECT s.id, s.name
       FROM sites s
      WHERE s.id = $1
        AND s.organization_id = $2
        ${ADMIN_ROLES.has(user?.role) ? '' : `AND EXISTS (
          SELECT 1 FROM user_sites permitted_site
           WHERE permitted_site.user_id = $3 AND permitted_site.site_id = s.id
        )`}
      LIMIT 1`,
    ADMIN_ROLES.has(user?.role)
      ? [siteId, user?.organization_id]
      : [siteId, user?.organization_id, user?.id]
  );
  return rows[0] || null;
};

/** Return every accessible registration for one mobile, best verified source first. */
export const findAccessiblePhoneMatches = async (db, { user, siteId, phone }) => {
  const normalizedPhone = normalizeMemberPhone(phone);
  if (!normalizedPhone) return [];
  const { rows } = await db.query(
    `SELECT m.id, m.site_id, s.name AS site_name, s.code AS site_code,
            m.full_name, m.phone, m.email, m.updated_at,
            m.co_applicant_name, m.co_applicant_relation, m.co_applicant_phone,
            m.co_applicant_aadhar, m.co_applicant_pan,
            verified.id AS verified_kyc_case_id,
            verified.verified_at AS kyc_verified_at
       FROM members m
       JOIN sites s ON s.id = m.site_id
       LEFT JOIN LATERAL (
         SELECT k.id, k.verified_at
           FROM kyc_cases k
          WHERE k.client_member_id = m.id AND k.status = 'VERIFIED'
          ORDER BY k.verified_at DESC NULLS LAST, k.id DESC
          LIMIT 1
       ) verified ON true
      WHERE s.organization_id = $1
        AND RIGHT(REGEXP_REPLACE(COALESCE(m.phone, ''), '[^0-9]', '', 'g'), 10) = $2
        ${siteAccessSql()}
      ORDER BY (m.site_id = $3) DESC,
               (verified.id IS NOT NULL) DESC,
               verified.verified_at DESC NULLS LAST,
               m.updated_at DESC NULLS LAST,
               m.id DESC
      LIMIT 25`,
    [user?.organization_id, normalizedPhone, siteId, ADMIN_ROLES.has(user?.role), user?.id]
  );
  return rows;
};

/** Load a full, accessible verified profile for safe server-side reuse. */
export const findVerifiedReuseSource = async (db, {
  user, siteId, phone, fullName, requestedMemberId = null,
}) => {
  const normalizedPhone = normalizeMemberPhone(phone);
  if (!normalizedPhone) return null;
  const normalizedName = normalizeMemberName(fullName);
  const params = [
    user?.organization_id, normalizedPhone, siteId,
    ADMIN_ROLES.has(user?.role), user?.id,
  ];
  let requestedSql = '';
  if (Number.isInteger(requestedMemberId)) {
    params.push(requestedMemberId);
    requestedSql = `AND m.id = $${params.length}`;
  } else {
    params.push(normalizedName);
    requestedSql = `AND UPPER(REGEXP_REPLACE(COALESCE(m.full_name, ''), '[^A-Za-z0-9]', '', 'g')) = $${params.length}`;
  }
  const { rows } = await db.query(
    `SELECT m.*, verified.id AS verified_kyc_case_id,
            verified.verified_by AS kyc_verified_by,
            verified.verified_at AS kyc_verified_at,
            source_site.name AS source_site_name
       FROM members m
       JOIN sites source_site ON source_site.id = m.site_id
       JOIN LATERAL (
         SELECT k.id, k.verified_by, k.verified_at
           FROM kyc_cases k
          WHERE k.client_member_id = m.id AND k.status = 'VERIFIED'
          ORDER BY k.verified_at DESC NULLS LAST, k.id DESC
          LIMIT 1
       ) verified ON true
      WHERE source_site.organization_id = $1
        AND RIGHT(REGEXP_REPLACE(COALESCE(m.phone, ''), '[^0-9]', '', 'g'), 10) = $2
        AND m.site_id <> $3
        ${siteAccessSql('source_site')}
        ${requestedSql}
      ORDER BY verified.verified_at DESC NULLS LAST, m.updated_at DESC NULLS LAST, m.id DESC
      LIMIT 1`,
    params
  );
  return rows[0] || null;
};
