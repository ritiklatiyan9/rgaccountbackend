import pool from '../config/db.js';

const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
export const TDS_DEDUCTEE_FIELDS = ['tds_member_id', 'tds_deductee_name', 'tds_pan', 'tds_aadhaar'];

export async function resolvePaymentDeductee(body, siteId, existing, { memberId, name, force = false } = {}, db = pool) {
  // Historical payments retain the taxpayer snapshot already captured on
  // their source; changing the Client's KYC later must not rewrite it.
  if (Number(existing?.tds_amount || 0) > 0) return resolveTdsDeductee(body, siteId, existing, db);
  const selected = force && memberId ? memberId : body.tds_member_id || body.related_member_id || memberId;
  const partyName = String(name || body.tds_deductee_name || '').trim();
  let inferred;
  if (!selected && partyName) {
    const { rows } = await db.query("SELECT id FROM members WHERE site_id=$1 AND UPPER(TRIM(full_name))=UPPER($2) AND UPPER(COALESCE(to_jsonb(members)->>'status','ACTIVE')) <> 'BLOCKED' LIMIT 2", [siteId, partyName]);
    if (rows.length === 1) inferred = rows[0].id;
  }
  return resolveTdsDeductee({ ...body, tds_member_id: selected || inferred || null, tds_deductee_name: selected || inferred ? body.tds_deductee_name : partyName || body.tds_deductee_name }, siteId, existing, db);
}

// The selected Client is the authority for KYC. Keep a snapshot on the source
// payment so editing and approval cannot lose its taxpayer mapping.
export async function resolveTdsDeductee(body, siteId, existing = null, db = pool) {
  const normalize = (key, value) => key === 'tds_member_id' ? Number(value) || null : String(value || '').trim();
  if (existing && TDS_DEDUCTEE_FIELDS.every(key => !Object.hasOwn(body, key) || normalize(key, body[key]) === normalize(key, existing[key]))) {
    return Object.fromEntries(TDS_DEDUCTEE_FIELDS.map(key => [key, existing[key] ?? null]));
  }
  const memberInput = Object.hasOwn(body, 'tds_member_id') ? body.tds_member_id : existing?.tds_member_id;
  const memberId = memberInput == null || memberInput === '' ? null : Number(memberInput);
  if (memberId !== null && !(Number.isSafeInteger(memberId) && memberId > 0)) fail('Choose a valid TDS client.');
  let name = String(body.tds_deductee_name ?? existing?.tds_deductee_name ?? '').trim().slice(0, 200);
  let pan = String(body.tds_pan ?? existing?.tds_pan ?? '').trim().toUpperCase();
  let aadhaar = String(body.tds_aadhaar ?? existing?.tds_aadhaar ?? '').replace(/\D/g, '');
  if (memberId !== null) {
    const { rows } = await db.query(`SELECT id, full_name, pan_no, aadhar_no FROM members
      WHERE id=$1 AND site_id=$2 AND UPPER(COALESCE(to_jsonb(members)->>'status','ACTIVE')) <> 'BLOCKED'`, [memberId, siteId]);
    if (!rows[0]) fail('The selected TDS client is not available in this site.');
    name = String(rows[0].full_name || '').trim().slice(0, 200);
    pan = String(rows[0].pan_no || '').trim().toUpperCase();
    aadhaar = String(rows[0].aadhar_no || '').replace(/\D/g, '');
  }
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail('Update the deductee PAN in Clients with a valid PAN.');
  if (aadhaar && !/^\d{12}$/.test(aadhaar)) fail('Update the deductee Aadhaar in Clients with a valid 12-digit number.');
  return { tds_member_id: memberId, tds_deductee_name: name || null, tds_pan: pan || null, tds_aadhaar: aadhaar || null };
}
