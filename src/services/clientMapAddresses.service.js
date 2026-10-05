import { addressParts, cacheKey, cleanLocationText, coordinates } from './clientLocation.js';
import { selectActiveDocuments } from './memberKycDocumentSelection.js';
import { combineReviewedDocuments } from './memberKycReview.service.js';
import { lookupIndianLocation } from './indiaLocationReference.js';

// Only the latest verified case for this member in this site. Latest OCR result
// per document and active document slots prevent old uploads winning a conflict.
export const MAP_KYC_ADDRESSES_SQL = `WITH cases AS (
  SELECT DISTINCT ON (k.client_member_id) k.id, k.client_member_id
  FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=$1
  WHERE k.site_id=$1 AND k.status='VERIFIED' AND k.client_member_id=ANY($2::int[])
  ORDER BY k.client_member_id, k.verified_at DESC NULLS LAST, k.id DESC
)
SELECT k.client_member_id AS member_id, k.id AS case_id,
  d.id, d.type, d.member_document_field, d.ocr_status,
  r.extracted_fields, r.confidence_map, r.raw_text
FROM cases k JOIN documents d ON d.kyc_case_id=k.id
LEFT JOIN LATERAL (
  SELECT extracted_fields, confidence_map, raw_text FROM ocr_results
  WHERE document_id=d.id ORDER BY id DESC LIMIT 1
) r ON true
WHERE d.site_id=$1 AND (d.client_member_id IS NULL OR d.client_member_id=k.client_member_id)
  AND d.type IN ('AADHAAR','VOTER_ID','PASSPORT','DL','KYC_FORM','OTHER')
ORDER BY k.client_member_id,d.id`;

export function applyVerifiedKycAddresses(members, documents) {
  const byMember = new Map();
  for (const document of documents) {
    if (!byMember.has(String(document.member_id))) byMember.set(String(document.member_id), []);
    byMember.get(String(document.member_id)).push(document);
  }
  return members.map(member => {
    const result = { ...member, address: cleanLocationText(member.address) || cleanLocationText(member.permanent_address),
      address_source: cleanLocationText(member.address) ? 'profile' : cleanLocationText(member.permanent_address) ? 'permanent' : null };
    const rows = byMember.get(String(member.id));
    if (!rows?.length) return result;
    const reviewed = combineReviewedDocuments(selectActiveDocuments(rows));
    result.kyc_case_id = rows[0].case_id;
    // Never combine an existing profile address with fields from another KYC
    // address. KYC is a fallback, not an overwrite of reviewed profile fields.
    if (!result.address && !reviewed.conflicts.address && reviewed.extracted.address) {
      result.address = reviewed.extracted.address;
      result.address_source = 'kyc';
      for (const field of ['city', 'state', 'pincode']) {
        if (!cleanLocationText(result[field]) && !reviewed.conflicts[field]) result[field] = reviewed.extracted[field] || '';
      }
    }
    result.kyc_address_needs_review = !result.address && (Boolean(reviewed.conflicts.address) || rows.some(row => row.ocr_status !== 'DONE') || reviewed.needsReprocessing.length > 0);
    return result;
  });
}

export async function loadClientMapAddresses(members, { db, siteId }) {
  if (!members.length) return members;
  const ids = members.filter(member => !cleanLocationText(member.address) && !cleanLocationText(member.permanent_address)).map(member => Number(member.id));
  const documents = ids.length ? (await db.query(MAP_KYC_ADDRESSES_SQL, [siteId, ids])).rows : [];
  const enriched = applyVerifiedKycAddresses(members, documents).map(member => {
    if (member.source === 'manual' || coordinates(member.lat, member.lng)) return member;
    const point = lookupIndianLocation({ ...addressParts(member), address: member.address });
    return point ? { ...member, lat: point.lat, lng: point.lng, source: point.source, precision: point.precision } : member;
  });
  const keys = [...new Set(enriched.filter(member => member.source !== 'manual' && !coordinates(member.lat, member.lng) && addressParts(member).has_address).map(cacheKey))];
  if (!keys.length) return enriched;
  const cached = await db.query(`SELECT query_key,lat,lng,precision,source,raw FROM geocode_cache
    WHERE query_key=ANY($1::text[]) AND lat IS NOT NULL AND created_at > now()-interval '180 days'`, [keys]);
  const points = new Map(cached.rows.map(row => [row.query_key, row]));
  return enriched.map(member => {
    if (member.source === 'manual' || coordinates(member.lat, member.lng)) return member;
    const point = points.get(cacheKey(member));
    const pair = point && coordinates(point.lat, point.lng);
    if (!pair) return member;
    const fields = point.source === 'ai_geonames' ? point.raw?.locality || {} : {};
    return { ...member, ...fields, ...pair, source: point.source, precision: point.precision };
  });
}
