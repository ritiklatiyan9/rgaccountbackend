// A direct plot link owns a document. Only legacy, unlinked documents fall
// back to their booking; a booking must never lend a deed to another plot.
export const registryDocumentScopeSql = (plotId) => `
  (d.plot_id = ${plotId} OR (d.plot_id IS NULL AND EXISTS (
    SELECT 1 FROM kyc_cases document_case
    JOIN bookings document_booking ON document_booking.id = document_case.booking_id
    WHERE document_case.id = d.kyc_case_id AND document_booking.plot_id = ${plotId}
  )))
  AND UPPER(TRIM(COALESCE(d.uploaded_source, 'BOOKING'))) <> 'DMS'
  AND NULLIF(TRIM(d.file_path), '') IS NOT NULL`;

export const registryDeedScopeSql = (plotId) => `
  ${registryDocumentScopeSql(plotId)}
  AND UPPER(TRIM(COALESCE(d.category, ''))) = 'REGISTRY'`;
