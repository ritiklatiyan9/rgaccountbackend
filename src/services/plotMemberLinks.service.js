import { PLOT_CO_APPLICANTS_JOIN, PLOT_CO_APPLICANTS_SELECT } from './plotCoApplicants.service.js';
// Prefer an explicitly selected member, then the recorded booking client. Older plots have only a buyer name;
// resolve that only when it identifies exactly one member in the same site.
export const PLOT_BUYER_MEMBER_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      -- Migration 149 may still be pending during deployment. A missing
      -- optional buyer link must not break member lists or plot searches.
      (SELECT m.id FROM members m
        WHERE m.id = (to_jsonb(p)->>'buyer_member_id')::integer AND m.site_id = p.site_id),
      (SELECT m.id
         FROM bookings b JOIN members m ON m.id = b.client_member_id AND m.site_id = p.site_id
        WHERE b.plot_id = p.id AND b.site_id = p.site_id
          AND COALESCE(b.status, '') NOT ILIKE 'cancel%'
        ORDER BY b.id DESC LIMIT 1),
      (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(m.id) END
         FROM members m WHERE m.site_id = p.site_id
          AND NULLIF(BTRIM(p.buyer_name), '') IS NOT NULL
          AND UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(p.buyer_name)))
    ) AS member_id
  ) buyer_link ON true
  LEFT JOIN members plot_buyer ON plot_buyer.id = buyer_link.member_id AND plot_buyer.site_id = p.site_id
`;

export const PLOT_BUYER_KYC_JOIN = `
  LEFT JOIN LATERAL (
    SELECT k.status FROM kyc_cases k
    WHERE k.client_member_id = plot_buyer.id AND k.site_id = p.site_id
    ORDER BY CASE k.status WHEN 'VERIFIED' THEN 4 WHEN 'OCR_DONE' THEN 3 WHEN 'OCR_PENDING' THEN 2 ELSE 1 END DESC,
             k.updated_at DESC NULLS LAST, k.id DESC
    LIMIT 1
  ) buyer_kyc ON true
`;

// Legacy profile completeness is distinct from a verified KYC case.
export const PLOT_BUYER_KYC_STATUS = `CASE
  WHEN plot_buyer.id IS NULL THEN NULL
  WHEN buyer_kyc.status IS NOT NULL THEN buyer_kyc.status
  WHEN COALESCE(NULLIF((to_jsonb(plot_buyer)->>'phone'), ''), NULLIF((to_jsonb(plot_buyer)->>'email'), '')) IS NOT NULL
    AND COALESCE(NULLIF((to_jsonb(plot_buyer)->>'address'), ''), NULLIF((to_jsonb(plot_buyer)->>'city'), '')) IS NOT NULL
    AND COALESCE(NULLIF((to_jsonb(plot_buyer)->>'aadhar_no'), ''), NULLIF((to_jsonb(plot_buyer)->>'pan_no'), ''), NULLIF((to_jsonb(plot_buyer)->>'voter_id'), ''),
      NULLIF((to_jsonb(plot_buyer)->>'passport_no'), ''), NULLIF((to_jsonb(plot_buyer)->>'driving_license_no'), '')) IS NOT NULL
    AND COALESCE(NULLIF((to_jsonb(plot_buyer)->>'aadhar_front_url'), ''), NULLIF((to_jsonb(plot_buyer)->>'aadhar_back_url'), ''), NULLIF((to_jsonb(plot_buyer)->>'pan_card_url'), ''),
      NULLIF((to_jsonb(plot_buyer)->>'voter_id_url'), ''), NULLIF((to_jsonb(plot_buyer)->>'passport_url'), ''), NULLIF((to_jsonb(plot_buyer)->>'driving_license_url'), ''),
      NULLIF((to_jsonb(plot_buyer)->>'cheque_url'), ''), NULLIF((to_jsonb(plot_buyer)->>'other_kyc_url'), '')) IS NOT NULL THEN 'COMPLETE'
  ELSE 'INCOMPLETE'
END`;

export function groupMemberPlotNumbers(rows) {
  const plotsByMember = new Map();
  for (const row of rows) {
    const plotNo = String(row.plot_no || '').trim();
    if (!plotNo) continue;
    for (const memberId of [row.buyer_member_id, ...(row.broker_member_ids || []), ...(row.co_applicants || []).map(person => person.member_id)]) {
      if (memberId == null) continue;
      const key = String(memberId);
      if (!plotsByMember.has(key)) plotsByMember.set(key, new Set());
      plotsByMember.get(key).add(plotNo);
    }
  }
  return new Map([...plotsByMember].map(([id, numbers]) => [
    id, [...numbers].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  ]));
}

/** Resolve all member plot numbers in one site query, including commission brokers. */
export async function findMemberPlots(siteId, pool) {
  const { rows } = await pool.query(`
    SELECT p.id, p.plot_no, p.plot_tag, p.buyer_name, plot_buyer.id AS buyer_member_id, ${PLOT_BUYER_KYC_STATUS} AS buyer_kyc_status, ${PLOT_CO_APPLICANTS_SELECT},
      ARRAY(
        SELECT m.id FROM members m
        WHERE m.site_id = p.site_id AND NULLIF(BTRIM(p.booking_by), '') IS NOT NULL
          AND UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(p.booking_by))
          AND NOT EXISTS (SELECT 1 FROM members duplicate
            WHERE duplicate.site_id = m.site_id AND duplicate.id <> m.id
              AND UPPER(BTRIM(duplicate.full_name)) = UPPER(BTRIM(m.full_name)))
        UNION
        SELECT m.id FROM plot_commissions_v2 pc
        JOIN members m ON m.id = pc.agent_id AND m.site_id = p.site_id
        WHERE pc.site_id = p.site_id AND pc.plot_id = p.id
        UNION
        SELECT m.id FROM plot_commissions pc
        JOIN members m ON m.site_id = p.site_id
          AND UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(pc.particular))
        WHERE pc.site_id = p.site_id AND UPPER(pc.plot_no) = UPPER(p.plot_no)
          AND NULLIF(BTRIM(pc.particular), '') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM members duplicate
            WHERE duplicate.site_id = m.site_id AND duplicate.id <> m.id
              AND UPPER(BTRIM(duplicate.full_name)) = UPPER(BTRIM(m.full_name)))
      ) AS broker_member_ids
    FROM plots p
    ${PLOT_BUYER_MEMBER_JOIN}
    ${PLOT_BUYER_KYC_JOIN}
    ${PLOT_CO_APPLICANTS_JOIN}
    WHERE p.site_id = $1
  `, [siteId]);
  return groupMemberPlots(rows);
}

export function groupMemberPlots(rows) {
  const members = new Map();
  for (const row of rows) {
    const plotNo = String(row.plot_no || '').trim();
    if (row.id == null || !plotNo) continue;
    for (const memberId of [row.buyer_member_id, ...(row.broker_member_ids || []), ...(row.co_applicants || []).map(person => person.member_id)]) {
      if (memberId == null) continue;
      const key = String(memberId);
      if (!members.has(key)) members.set(key, new Map());
      const coApplicant = (row.co_applicants || []).find(person => Number(person.member_id) === Number(memberId));
      members.get(key).set(String(row.id), { id: row.id, plot_no: plotNo, plot_tag: row.plot_tag || null,
        ...(row.buyer_name !== undefined ? { buyer_name: row.buyer_name, buyer_member_id: row.buyer_member_id, buyer_kyc_status: row.buyer_kyc_status, co_applicants: row.co_applicants || [], applicant_role: Number(row.buyer_member_id) === Number(memberId) ? 'buyer' : coApplicant ? 'co_applicant' : 'broker' } : coApplicant ? { applicant_role: 'co_applicant', co_applicants: row.co_applicants } : {}),
      });
    }
  }
  return new Map([...members].map(([id, plots]) => [id, [...plots.values()].sort((a, b) =>
    a.plot_no.localeCompare(b.plot_no, 'en', { numeric: true }) || Number(a.id) - Number(b.id)
  )]));
}

export async function findMemberPlotNumbers(siteId, pool) {
  const plots = await findMemberPlots(siteId, pool);
  return new Map([...plots].map(([id, links]) => [id, [...new Set(links.map((plot) => plot.plot_no))]]));
}

export async function validatePlotBuyerMember(siteId, memberId, pool) {
  if (!['string', 'number'].includes(typeof memberId) || !Number.isSafeInteger(Number(memberId)) || Number(memberId) <= 0) {
    throw Object.assign(new Error('Select a KYC user to link to this plot.'), { statusCode: 400 });
  }
  const { rows: [member] } = await pool.query(
    'SELECT id FROM members WHERE id = $1 AND site_id = $2', [Number(memberId), siteId],
  );
  if (!member) throw Object.assign(new Error('Select a user registered in the same site as this plot.'), { statusCode: 400 });
  return member.id;
}
