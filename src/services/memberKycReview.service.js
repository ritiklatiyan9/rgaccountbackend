import { normaliseResult } from './memberKycOcr.service.js';

// Historical extractions without source evidence must be reprocessed, not trusted.
export const reviewDocument = (document) => {
  const { raw_text: raw, ...publicDocument } = document;
  const result = document.ocr_status === 'DONE' ? normaliseResult({
    fields: document.extracted_fields,
    confidence: document.confidence_map,
    evidence: raw?.evidence,
  }, raw?.text, document.type) : { fields: {}, confidence: {}, evidence: {} };
  return {
    ...publicDocument,
    extracted_fields: result.fields,
    confidence_map: result.confidence,
    evidence: result.evidence,
    needs_reprocessing: document.type !== 'PHOTO' && document.ocr_status === 'DONE' && !raw?.evidence,
  };
};

export const combineReviewedDocuments = (documents) => {
  const extracted = {};
  const confidence = {};
  const evidence = {};
  const conflicts = {};
  const candidates = {};
  for (const document of documents) {
    const reviewed = reviewDocument(document);
    for (const [field, value] of Object.entries(reviewed.extracted_fields)) {
      (candidates[field] ||= []).push({ value, documentId: document.id,
        confidence: reviewed.confidence_map[field], quote: reviewed.evidence[field] });
    }
  }
  for (const [field, items] of Object.entries(candidates)) {
    const values = new Set(items.map(({ value }) => value.trim().replace(/\s+/g, ' ').toLowerCase()));
    if (values.size > 1) {
      conflicts[field] = items;
      continue;
    }
    const selected = items.reduce((a, b) => a.confidence >= b.confidence ? a : b);
    extracted[field] = selected.value;
    confidence[field] = selected.confidence;
    evidence[field] = { documentId: selected.documentId, quote: selected.quote };
  }
  return { extracted, confidence, evidence, conflicts,
    needsReprocessing: documents.filter((d) => reviewDocument(d).needs_reprocessing).map((d) => d.id) };
};
