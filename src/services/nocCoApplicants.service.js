import { plotCoApplicants, PLOT_CO_APPLICANTS_JOIN, PLOT_CO_APPLICANTS_SELECT } from './plotCoApplicants.service.js';

/** Each named joint purchaser uses their own site-scoped KYC case. */
export async function resolveNocCoApplicants(db, siteId, plotId, legacyMember = null) {
  const plot = plotId ? (await db.query(`SELECT ${PLOT_CO_APPLICANTS_SELECT} FROM plots p
    ${PLOT_CO_APPLICANTS_JOIN} WHERE p.id=$1 AND p.site_id=$2`, [plotId, siteId])).rows[0] : null;
  const rows = plotCoApplicants(plot || {});
  if (!rows.length && legacyMember?.co_applicant_name) rows.push({ member_id: null, full_name: legacyMember.co_applicant_name,
    relation: legacyMember.co_applicant_relation, phone: legacyMember.co_applicant_phone,
    aadhar_no: legacyMember.co_aadhar, pan_no: legacyMember.co_pan, kyc_status: 'UNLINKED', source: 'client' });
  return rows.map(row => ({ ...row, name: row.full_name,
    id_ready: Boolean(String(row.aadhar_no || '').trim() || String(row.pan_no || '').trim()),
    kyc_status: row.kyc_status || 'UNLINKED', kyc_verified: row.kyc_status === 'VERIFIED', source: row.source || 'plot' }));
}

export function nocCoApplicantBlockers(rows, includeCo) {
  if (!includeCo) return [];
  if (!rows.length) return ['Co-applicants are switched on, but none are linked to this plot'];
  return rows.flatMap(row => !row.member_id
    ? [`${row.name || row.full_name}: link this co-applicant to a client and complete their KYC`]
    : row.kyc_status !== 'VERIFIED' ? [`${row.name || row.full_name}: KYC not verified (${row.kyc_status || 'NOT_STARTED'})`] : []);
}
