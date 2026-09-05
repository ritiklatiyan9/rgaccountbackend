// Prefer the recorded booking client. Older plots have only a buyer name;
// resolve that only when it identifies exactly one member in the same site.
export const PLOT_BUYER_MEMBER_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(
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
  WHEN COALESCE(NULLIF(plot_buyer.phone, ''), NULLIF(plot_buyer.email, '')) IS NOT NULL
    AND COALESCE(NULLIF(plot_buyer.address, ''), NULLIF(plot_buyer.city, '')) IS NOT NULL
    AND COALESCE(NULLIF(plot_buyer.aadhar_no, ''), NULLIF(plot_buyer.pan_no, ''), NULLIF(plot_buyer.voter_id, ''),
      NULLIF(plot_buyer.passport_no, ''), NULLIF(plot_buyer.driving_license_no, '')) IS NOT NULL
    AND COALESCE(NULLIF(plot_buyer.aadhar_front_url, ''), NULLIF(plot_buyer.aadhar_back_url, ''), NULLIF(plot_buyer.pan_card_url, ''),
      NULLIF(plot_buyer.voter_id_url, ''), NULLIF(plot_buyer.passport_url, ''), NULLIF(plot_buyer.driving_license_url, ''),
      NULLIF(plot_buyer.cheque_url, ''), NULLIF(plot_buyer.other_kyc_url, '')) IS NOT NULL THEN 'COMPLETE'
  ELSE 'INCOMPLETE'
END`;

export function groupMemberPlotNumbers(rows) {
  const plotsByMember = new Map();
  for (const row of rows) {
    const plotNo = String(row.plot_no || '').trim();
    if (!plotNo) continue;
    for (const memberId of [row.buyer_member_id, ...(row.broker_member_ids || [])]) {
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
export async function findMemberPlotNumbers(siteId, pool) {
  const { rows } = await pool.query(`
    SELECT p.plot_no, plot_buyer.id AS buyer_member_id,
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
    WHERE p.site_id = $1
  `, [siteId]);
  return groupMemberPlotNumbers(rows);
}
