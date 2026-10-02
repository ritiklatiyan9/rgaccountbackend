/** Keep independent document records/permissions but reuse permanent storage
 * keys. Deduplicate inherited documents, preferring the closest source copy.
 * Insert ancestors first so the source's own documents take priority.
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
     SELECT selected.id FROM (
       SELECT DISTINCT ON (d.file_path,d.type,COALESCE(d.member_document_field,'')) d.id,l.depth
         FROM lineage l JOIN documents d ON d.kyc_case_id = l.id
        ORDER BY d.file_path,d.type,COALESCE(d.member_document_field,''),l.depth ASC,d.id DESC
     ) selected ORDER BY selected.depth DESC,selected.id ASC`,
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
