// This feed follows the current Clients directory: deleted registrations and
// already-verified people have no pending KYC work. Historical cases/documents
// remain stored for audit and recovery.
export const PENDING_MEMBER_KYC_SQL = `WITH document_stats AS (
       SELECT d.kyc_case_id,
              COUNT(*)::int AS document_count,
              COUNT(*) FILTER (WHERE d.ocr_status = 'DONE')::int AS completed_documents,
              COUNT(*) FILTER (WHERE d.ocr_status IN ('PENDING', 'PROCESSING'))::int AS processing_documents,
              COUNT(*) FILTER (WHERE d.ocr_status = 'FAILED')::int AS failed_documents
         FROM documents d
         JOIN kyc_cases scoped_case ON scoped_case.id = d.kyc_case_id
        WHERE scoped_case.site_id = $1
          AND scoped_case.status NOT IN ('VERIFIED', 'REJECTED')
        GROUP BY d.kyc_case_id
     ), pending_cases AS (
       SELECT k.id::bigint AS id,
              k.id AS kyc_case_id,
              'KYC_CASE'::text AS source_kind,
              k.site_id, k.booking_id, k.client_member_id, k.mode, k.status,
              k.created_at, k.updated_at,
              m.full_name AS client_name, m.phone AS client_phone,
              s.name AS site_name,
              COALESCE(u.name, u.email) AS created_by_name,
              COALESCE(ds.document_count, 0)::int AS document_count,
              COALESCE(ds.completed_documents, 0)::int AS completed_documents,
              COALESCE(ds.processing_documents, 0)::int AS processing_documents,
              COALESCE(ds.failed_documents, 0)::int AS failed_documents,
              ARRAY[]::text[] AS missing_fields
         FROM kyc_cases k
         JOIN members m ON m.id = k.client_member_id AND m.site_id = k.site_id
         LEFT JOIN sites s ON s.id = k.site_id
         LEFT JOIN users u ON u.id = k.created_by
         LEFT JOIN document_stats ds ON ds.kyc_case_id = k.id
        WHERE k.site_id = $1
          AND k.status NOT IN ('VERIFIED', 'REJECTED')
          AND NOT EXISTS (
            SELECT 1 FROM kyc_cases verified_case
             WHERE verified_case.client_member_id = m.id
               AND verified_case.site_id = m.site_id
               AND verified_case.status = 'VERIFIED'
          )
     ), incomplete_members AS (
       SELECT (-m.id)::bigint AS id,
              NULL::bigint AS kyc_case_id,
              'MEMBER_PROFILE'::text AS source_kind,
              m.site_id,
              NULL::bigint AS booking_id,
              m.id AS client_member_id,
              'PROFILE'::text AS mode,
              'PROFILE_INCOMPLETE'::text AS status,
              m.created_at,
              m.updated_at,
              m.full_name AS client_name,
              m.phone AS client_phone,
              s.name AS site_name,
              COALESCE(profile_creator.name, profile_creator.email) AS created_by_name,
              (SELECT COUNT(*)::int FROM UNNEST(ARRAY[
                m.aadhar_front_url, m.aadhar_back_url, m.pan_card_url, m.voter_id_url,
                m.passport_url, m.driving_license_url, m.cheque_url, m.other_kyc_url
              ]) AS profile_document(url)
               WHERE NULLIF(BTRIM(COALESCE(url, '')), '') IS NOT NULL) AS document_count,
              0::int AS completed_documents,
              0::int AS processing_documents,
              0::int AS failed_documents,
              ARRAY_REMOVE(ARRAY[
                CASE WHEN NULLIF(BTRIM(COALESCE(m.phone, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.email, '')), '') IS NULL
                     THEN 'contact' END,
                CASE WHEN NULLIF(BTRIM(COALESCE(m.address, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.city, '')), '') IS NULL
                     THEN 'address' END,
                CASE WHEN NULLIF(BTRIM(COALESCE(m.aadhar_no, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.pan_no, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.voter_id, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.passport_no, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.driving_license_no, '')), '') IS NULL
                     THEN 'identity' END,
                CASE WHEN NULLIF(BTRIM(COALESCE(m.aadhar_front_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.aadhar_back_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.pan_card_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.voter_id_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.passport_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.driving_license_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.cheque_url, '')), '') IS NULL
                           AND NULLIF(BTRIM(COALESCE(m.other_kyc_url, '')), '') IS NULL
                     THEN 'document' END
              ], NULL)::text[] AS missing_fields
         FROM members m
         LEFT JOIN sites s ON s.id = m.site_id
         LEFT JOIN users profile_creator ON profile_creator.id = m.created_by
        WHERE m.site_id = $1
          AND (
            (NULLIF(BTRIM(COALESCE(m.phone, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.email, '')), '') IS NULL)
            OR (NULLIF(BTRIM(COALESCE(m.address, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.city, '')), '') IS NULL)
            OR (NULLIF(BTRIM(COALESCE(m.aadhar_no, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.pan_no, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.voter_id, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.passport_no, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.driving_license_no, '')), '') IS NULL)
            OR (NULLIF(BTRIM(COALESCE(m.aadhar_front_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.aadhar_back_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.pan_card_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.voter_id_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.passport_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.driving_license_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.cheque_url, '')), '') IS NULL
              AND NULLIF(BTRIM(COALESCE(m.other_kyc_url, '')), '') IS NULL)
          )
          AND NOT EXISTS (
            SELECT 1
              FROM kyc_cases verified_case
             WHERE verified_case.client_member_id = m.id
               AND verified_case.site_id = m.site_id
               AND verified_case.status = 'VERIFIED'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM kyc_cases open_case
             WHERE open_case.client_member_id = m.id
               AND open_case.site_id = m.site_id
               AND open_case.status NOT IN ('VERIFIED', 'REJECTED')
          )
     ), lookout_cases AS (
       SELECT * FROM pending_cases
       UNION ALL
       SELECT * FROM incomplete_members
     )
     SELECT lookout_cases.*, COUNT(*) OVER()::int AS total_count
       FROM lookout_cases
      ORDER BY
        CASE status
          WHEN 'OCR_DONE' THEN 0
          WHEN 'OCR_PENDING' THEN 1
          WHEN 'PROFILE_INCOMPLETE' THEN 2
          ELSE 3
        END,
        COALESCE(updated_at, created_at) ASC,
        id ASC
      LIMIT $2`;

export async function readPendingMemberKycCases(db, siteId, limit = 500) {
  const { rows } = await db.query(PENDING_MEMBER_KYC_SQL, [siteId, limit]);
  const total = rows[0]?.total_count || 0;
  return {
    cases: rows.map(({ total_count, ...record }) => record),
    total,
    truncated: total > rows.length,
  };
}
