import {
  assertMemberSiteAccess, normalizeMemberName, normalizeMemberPhone, reuseVerifiedKycForMember,
} from './memberPhoneReuse.service.js';
import { signMemberDocumentUrl } from '../utils/memberDocumentUrls.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const SEARCH_LIMIT = 40;
const UNVERIFIED_LIMIT = 10;
// Measured on real cross-site pairs: one person's spellings ("SAURAV MALIK" /
// "SOURAV MALIK (KIWANA)") scored >= 0.43, different people who only share a
// surname ("AKASH SHARMA" / "SONU SHARMA") <= 0.41. Substring matches always count.
const NAME_SIMILARITY = 0.42;

const fail = (statusCode, message) => {
  throw Object.assign(new Error(message), { statusCode });
};
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const identityValue = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sameMobile = (a, b) => Boolean(normalizeMemberPhone(a)) && normalizeMemberPhone(a) === normalizeMemberPhone(b);
const sameName = (a, b) => Boolean(normalizeMemberName(a)) && normalizeMemberName(a) === normalizeMemberName(b);

/** Label of the first Aadhaar/PAN number both registrations hold but disagree on. */
const identityConflict = (target, source) => [['aadhar_no', 'Aadhaar'], ['pan_no', 'PAN']]
  .find(([field]) => {
    const existing = identityValue(target[field]);
    const incoming = identityValue(source[field]);
    return existing && incoming && existing !== incoming;
  })?.[1] || null;

/**
 * The mobile is the strongest link between two registrations, yet the same
 * person is often spelled differently per site, or registered without (or
 * with an older) mobile. Those need the operator's explicit confirmation;
 * a missing name or conflicting Aadhaar/PAN can never be confirmed away.
 */
export const assertMatchingKycIdentity = (target, source, { samePersonConfirmed = false } = {}) => {
  if (!normalizeMemberName(target.full_name) || !normalizeMemberName(source.full_name)) {
    fail(409, 'Both registrations must have a name. Review the registrations first.');
  }
  const conflict = identityConflict(target, source);
  if (conflict) {
    fail(409, `${conflict} details differ between these registrations. Review them before incorporating KYC.`);
  }
  if (samePersonConfirmed === true) return;
  if (!sameMobile(target.phone, source.phone)) {
    fail(409, 'The mobile numbers do not match. Confirm that these registrations belong to the same person before incorporating KYC.');
  }
  if (!sameName(target.full_name, source.full_name)) {
    fail(409, 'The names differ. Confirm that these registrations belong to the same person before incorporating KYC.');
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

/**
 * What the operator typed: a (partial) mobile number or a name. An empty
 * search starts from this registration's own mobile, else from its name.
 */
export const parseKycSourceQuery = (raw, target = {}) => {
  let text = String(raw ?? '').trim().slice(0, 80);
  if (!text) {
    const phone = normalizeMemberPhone(target.phone);
    if (phone) return { mode: 'phone', value: phone };
    text = String(target.full_name || '').trim();
  }
  if (!/\p{L}/u.test(text)) {
    const digits = normalizeMemberPhone(text) || text.replace(/\D/g, '');
    return { mode: digits.length >= 4 ? 'phone' : 'none', value: digits };
  }
  const name = normalizeMemberName(text);
  return { mode: name.length >= 3 ? 'name' : 'none', value: name, text };
};

const DIGITS = (column) => `REGEXP_REPLACE(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;

const searchSql = (mode, fuzzy) => {
  const match = mode === 'phone'
    ? `(${['m.phone', 'm.alt_phone', 'm.whatsapp'].map((column) => `${DIGITS(column)} LIKE '%' || $5 || '%'`).join(' OR ')})`
    : `(UPPER(REGEXP_REPLACE(COALESCE(m.full_name, ''), '[^[:alnum:]]', '', 'g')) LIKE '%' || $5 || '%'${fuzzy
      ? ` OR similarity(UPPER(m.full_name), UPPER($6)) >= ${NAME_SIMILARITY}` : ''})`;
  const rank = mode === 'phone'
    ? `(RIGHT(${DIGITS('m.phone')}, 10) = $5) DESC`
    : fuzzy ? 'similarity(UPPER(m.full_name), UPPER($6)) DESC' : 'm.full_name ASC';
  return `SELECT m.id, m.site_id, s.name AS site_name, m.full_name, m.father_name, m.city,
                 m.phone, m.photo, m.aadhar_no, m.pan_no,
                 verified.id AS verified_kyc_case_id, verified.verified_at AS kyc_verified_at
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
             AND m.site_id <> $2
             AND ($3::boolean OR EXISTS (
               SELECT 1 FROM user_sites permitted_site
                WHERE permitted_site.user_id = $4 AND permitted_site.site_id = s.id
             ))
             AND ${match}
           ORDER BY (verified.id IS NOT NULL) DESC, ${rank}, verified.verified_at DESC NULLS LAST, m.id DESC
           LIMIT ${SEARCH_LIMIT}`;
};

const searchCandidates = async (db, { user, target, query }) => {
  const params = [user?.organization_id, target.site_id, ADMIN_ROLES.has(user?.role), user?.id, query.value];
  if (query.mode === 'phone') return (await db.query(searchSql('phone'), params)).rows;
  try {
    return (await db.query(searchSql('name', true), [...params, query.text])).rows;
  } catch (error) {
    // Migration 069 lets pg_trgm be absent; spelling tolerance is then lost, not search.
    if (error.code !== '42883') throw error;
    return (await db.query(searchSql('name', false), params)).rows;
  }
};

/**
 * Registrations of the same person in the operator's other sites. `sources`
 * hold verified KYC and can be incorporated; `others` are shown so a search
 * that finds someone without verified KYC explains itself. Aadhaar/PAN
 * numbers are compared here and never returned.
 */
export const listMemberKycSources = async (db, { user, memberId, query: rawQuery = '' }) => {
  const target = await accessibleTarget(db, user, memberId);
  const hasMobile = Boolean(normalizeMemberPhone(target.phone));
  const query = parseKycSourceQuery(rawQuery, target);
  const { rows: verified } = await db.query(
    "SELECT id FROM kyc_cases WHERE client_member_id = $1 AND site_id = $2 AND status = 'VERIFIED' LIMIT 1",
    [target.id, target.site_id],
  );
  const empty = { has_mobile: hasMobile, query: { mode: query.mode, value: query.value }, sources: [], others: [] };
  if (verified.length) return { ...empty, already_verified: true };
  if (query.mode === 'none') return { ...empty, already_verified: false };

  // Same mobile first, then same name; sort is stable, so the SQL order breaks ties.
  const score = (row) => (sameMobile(target.phone, row.phone) ? 2 : 0) + (sameName(target.full_name, row.full_name) ? 1 : 0);
  const ranked = (await searchCandidates(db, { user, target, query }))
    .filter((row) => Number(row.id) !== Number(target.id))
    .sort((a, b) => score(b) - score(a));
  const toResult = async (row) => ({
    id: row.id, site_id: row.site_id, site_name: row.site_name,
    full_name: row.full_name, father_name: row.father_name || '', city: row.city || '',
    phone: row.phone || '', photo: row.photo ? await signMemberDocumentUrl(row.photo) : null,
    verified_at: row.kyc_verified_at || null,
    name_matches: sameName(target.full_name, row.full_name),
    mobile_matches: sameMobile(target.phone, row.phone),
    identity_conflict: identityConflict(target, row),
  });
  return {
    ...empty,
    already_verified: false,
    sources: await Promise.all(ranked.filter((row) => row.verified_kyc_case_id).map(toResult)),
    // Unverified rows only explain a search, so spelling-only lookalikes are left out.
    others: await Promise.all(ranked.filter((row) => !row.verified_kyc_case_id
      && (query.mode === 'phone' || normalizeMemberName(row.full_name).includes(query.value)))
      .slice(0, UNVERIFIED_LIMIT).map(toResult)),
  };
};

/** A verified registration in another site the user can read, by id alone. */
const findVerifiedSourceById = async (db, { user, siteId, memberId }) => {
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
        AND m.id = $2
        AND m.site_id <> $3
        AND ($4::boolean OR EXISTS (
          SELECT 1 FROM user_sites permitted_site
           WHERE permitted_site.user_id = $5 AND permitted_site.site_id = source_site.id
        ))
      LIMIT 1`,
    [user?.organization_id, memberId, siteId, ADMIN_ROLES.has(user?.role), user?.id],
  );
  return rows[0] || null;
};

/** Adopting the verified mobile must not give two registrations in one site the same number. */
const assertMobileFreeInSite = async (db, { target, source }) => {
  const phone = normalizeMemberPhone(source.phone);
  if (!phone || phone === normalizeMemberPhone(target.phone)) return;
  // Same lock key as member create, so a concurrent "Add user" cannot take the number meanwhile.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`accounts-member-phone:${target.site_id}:${phone}`]);
  const { rows } = await db.query(
    `SELECT id, full_name FROM members
      WHERE site_id = $1 AND id <> $2
        AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = $3
      LIMIT 1`,
    [target.site_id, target.id, phone],
  );
  if (rows[0]) {
    fail(409, `Mobile ${phone} is already registered to ${rows[0].full_name} in this site. Incorporate KYC into that registration instead.`);
  }
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

export const incorporateMemberKyc = async (pool, { user, memberId, sourceMemberId, samePersonConfirmed = false }) => {
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
    const source = await findVerifiedSourceById(db, {
      user, siteId: target.site_id, memberId: Number(sourceMemberId),
    });
    if (!source) fail(409, 'Verified KYC is no longer available from this registration. Refresh and choose a source again.');
    assertMatchingKycIdentity(target, source, { samePersonConfirmed });
    await assertMobileFreeInSite(db, { target, source });
    const { rows: sourceCases } = await db.query(
      "SELECT id FROM kyc_cases WHERE id = $1 AND status = 'VERIFIED' FOR SHARE",
      [source.verified_kyc_case_id],
    );
    if (!sourceCases.length) fail(409, 'The source KYC has changed. Refresh and try again.');
    const result = await reuseVerifiedKycForMember(db, {
      source, targetMember: target, siteId: target.site_id, userId: user.id,
      samePersonConfirmed: samePersonConfirmed === true,
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
