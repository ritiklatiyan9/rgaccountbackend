export const DOCUMENT_FIELDS_BY_TYPE = {
  PHOTO: ['photo'],
  AADHAAR: ['aadhar_front_url', 'aadhar_back_url'],
  PAN: ['pan_card_url'],
  VOTER_ID: ['voter_id_url'],
  PASSPORT: ['passport_url'],
  DL: ['driving_license_url'],
  CHEQUE: ['cheque_url'],
  KYC_FORM: ['other_kyc_url'],
  OTHER: ['other_kyc_url'],
};

const newestDocument = (documents = []) => documents.reduce(
  (latest, document) => (!latest || Number(document.id) > Number(latest.id) ? document : latest),
  null
);

/**
 * Return the current document in each member-profile slot while retaining every
 * upload row in the database as immutable history. Older shared KYC rows did not
 * record a slot, so the newest legacy document remains the compatibility fallback.
 */
export const selectActiveDocuments = (rows = []) => {
  const active = [];
  const aadhaar = rows.filter((document) => document.type === 'AADHAAR');
  const labelledAadhaar = (field) => newestDocument(
    aadhaar.filter((document) => document.member_document_field === field)
  );
  let front = labelledAadhaar('aadhar_front_url');
  let back = labelledAadhaar('aadhar_back_url');
  const legacyAadhaar = aadhaar
    .filter((document) => !document.member_document_field)
    .sort((left, right) => Number(left.id) - Number(right.id));

  if (!front && !back) {
    const latestPair = legacyAadhaar.slice(-2);
    [front, back] = latestPair;
  } else if (!front) {
    front = legacyAadhaar.at(-1) || null;
  } else if (!back) {
    back = legacyAadhaar.at(-1) || null;
  }

  const nonAadhaar = rows.filter((document) => document.type !== 'AADHAAR');
  const labelledBySlot = new Map();
  for (const document of nonAadhaar.filter((item) => item.member_document_field)) {
    const current = labelledBySlot.get(document.member_document_field);
    if (!current || Number(document.id) > Number(current.id)) {
      labelledBySlot.set(document.member_document_field, document);
    }
  }
  active.push(...labelledBySlot.values());

  const labelledTypes = new Set([...labelledBySlot.values()].map((document) => document.type));
  const legacyByType = new Map();
  for (const document of nonAadhaar.filter((item) => !item.member_document_field)) {
    const expectedSlots = DOCUMENT_FIELDS_BY_TYPE[document.type] || [];
    if (labelledTypes.has(document.type)
      || expectedSlots.some((field) => labelledBySlot.has(field))) continue;
    const current = legacyByType.get(document.type);
    if (!current || Number(document.id) > Number(current.id)) legacyByType.set(document.type, document);
  }
  active.push(...legacyByType.values());

  active.sort((left, right) => Number(left.id) - Number(right.id));
  if (front) active.push(front);
  if (back) active.push(back);
  return active;
};

