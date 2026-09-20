import {
  assertMemberSiteAccess, findAccessiblePhoneMatches, findVerifiedReuseSource,
  normalizeMemberName, normalizeMemberPhone, reuseVerifiedKycForMember,
} from './memberPhoneReuse.service.js';

const fail = (statusCode, message) => {
  throw Object.assign(new Error(message), { statusCode });
};
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const identityValue = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const assertMatchingKycIdentity = (target, source) => {
  const phone = normalizeMemberPhone(target.phone);
  const name = normalizeMemberName(target.full_name);
  if (!phone || !name || phone !== normalizeMemberPhone(source.phone)
    || name !== normalizeMemberName(source.full_name)) {
    fail(409, 'The client name and mobile number must match in both sites. Review the registrations first.');
  }
  for (const [field, label] of [['aadhar_no', 'Aadhaar'], ['pan_no', 'PAN']]) {
    const existing = identityValue(target[field]);
    const incoming = identityValue(source[field]);
    if (existing && incoming && existing !== incoming) {
      fail(409, `${label} details differ between these registrations. Review them before incorporating KYC.`);
    }
  }
};

const accessibleTarget = async (db, user, memberId) => {
  if (!positiveId(memberId)) fail(400, 'A valid client is required.');
  const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [Number(memberId)]);
  const target = rows[0];
  if (!target || !(await assertMemberSiteAccess(db, user, target.site_id))) {
    fail(404, 'Client not found or unavailable to your account.');
  }
  return target;
};

export const listMemberKycSources = async (db, { user, memberId }) => {
  const target = await accessibleTarget(db, user, memberId);
  const { rows: verified } = await db.query(
    "SELECT id FROM kyc_cases WHERE client_member_id = $1 AND site_id = $2 AND status = 'VERIFIED' LIMIT 1",
    [target.id, target.site_id],
  );
  const matches = verified.length ? [] : await findAccessiblePhoneMatches(db, {
    user, siteId: target.site_id, phone: target.phone,
  });
  const name = normalizeMemberName(target.full_name);
  const sources = matches.filter((source) => name
    && Number(source.site_id) !== Number(target.site_id)
    && source.verified_kyc_case_id
    && normalizeMemberPhone(source.phone) === normalizeMemberPhone(target.phone)
    && normalizeMemberName(source.full_name) === name).map((source) => ({
    id: source.id, site_id: source.site_id, site_name: source.site_name,
    full_name: source.full_name, phone: source.phone, verified_at: source.kyc_verified_at,
  }));
  return { already_verified: Boolean(verified.length), has_mobile: Boolean(normalizeMemberPhone(target.phone)), sources };
};

/** Keep independent document records/permissions but reuse the permanent storage
 * keys. Include inherited documents for registrations whose KYC was itself reused.
 * Oldest ancestors are inserted first so the source's own documents take priority.
 */
export const copyIncorporatedKycDocuments = async (db, {
  sourceCaseId, targetCaseId, memberId, siteId, userId, organizationId,
}) => {
  const { rows } = await db.query(
    `WITH RECURSIVE lineage AS (
       SELECT k.id, k.reused_from_case_id, ARRAY[k.id] AS visited, 0 AS depth
         FROM kyc_cases k JOIN sites s ON s.id = k.site_id
        WHERE k.id = $1 AND s.organization_id = $2
       UNION ALL
       SELECT k.id, k.reused_from_case_id, l.visited || k.id, l.depth + 1
         FROM lineage l JOIN kyc_cases k ON k.id = l.reused_from_case_id
         JOIN sites s ON s.id = k.site_id
        WHERE NOT k.id = ANY(l.visited) AND s.organization_id = $2
     )
     SELECT d.id FROM lineage l JOIN documents d ON d.kyc_case_id = l.id
      ORDER BY l.depth DESC, d.id ASC`,
    [sourceCaseId, organizationId],
  );
  for (const document of rows) {
    const { rows: copied } = await db.query(
      `INSERT INTO documents
         (kyc_case_id, client_member_id, site_id, type, member_document_field,
          original_name, file_path, file_hash, mime_type, file_size, ocr_status,
          ocr_engine, ocr_completed_at, ocr_error, uploaded_source, uploaded_by, created_at, updated_at)
       SELECT $1, $2, $3, type, member_document_field,
              original_name, file_path, file_hash, mime_type, file_size, ocr_status,
              ocr_engine, ocr_completed_at, ocr_error, 'ACCOUNT', $4, now(), now()
         FROM documents WHERE id = $5 RETURNING id`,
      [targetCaseId, memberId, siteId, userId, document.id],
    );
    await db.query(
      `INSERT INTO ocr_results
         (document_id, raw_text, extracted_fields, confidence_overall, confidence_map, engine, processed_at)
       SELECT $1, raw_text, extracted_fields, confidence_overall, confidence_map, engine, processed_at
         FROM ocr_results WHERE document_id = $2 ORDER BY id DESC LIMIT 1`,
      [copied[0].id, document.id],
    );
  }
};

export const incorporateMemberKyc = async (pool, { user, memberId, sourceMemberId }) => {
  if (!positiveId(memberId) || !positiveId(sourceMemberId) || Number(memberId) === Number(sourceMemberId)) {
    fail(400, 'Choose a client registration from another site.');
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Deterministic row order also serialises concurrent incorporation requests.
    await db.query('SELECT id FROM members WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
      [[Number(memberId), Number(sourceMemberId)]]);
    const target = await accessibleTarget(db, user, memberId);
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`accounts-member-kyc-member:${target.id}`]);
    const source = await findVerifiedReuseSource(db, {
      user, siteId: target.site_id, phone: target.phone, fullName: target.full_name,
      requestedMemberId: Number(sourceMemberId),
    });
    if (!source) fail(409, 'Verified KYC is no longer available from this registration. Refresh and choose a source again.');
    assertMatchingKycIdentity(target, source);
    const { rows: sourceCases } = await db.query(
      "SELECT id FROM kyc_cases WHERE id = $1 AND status = 'VERIFIED' FOR SHARE",
      [source.verified_kyc_case_id],
    );
    if (!sourceCases.length) fail(409, 'The source KYC has changed. Refresh and try again.');
    const result = await reuseVerifiedKycForMember(db, {
      source, targetMember: target, siteId: target.site_id, userId: user.id,
    });
    if (result.kycReused) {
      await copyIncorporatedKycDocuments(db, {
        sourceCaseId: source.verified_kyc_case_id, targetCaseId: result.kycCaseId,
        memberId: target.id, siteId: target.site_id, userId: user.id, organizationId: user.organization_id,
      });
    } else if (result.reason !== 'ALREADY_VERIFIED') {
      fail(409, 'KYC could not be incorporated. Review the registrations and try again.');
    }
    await db.query('COMMIT');
    return {
      kyc_reused: result.kycReused, kyc_case_id: result.kycCaseId,
      source_site_name: source.source_site_name,
      message: result.kycReused ? `KYC incorporated from ${source.source_site_name}.` : 'This client already has verified KYC.',
    };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
};
