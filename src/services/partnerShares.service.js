import pool from '../config/db.js';

// Partner splits: a site's (site_partner_shares) and, where a land involves a different
// set of partners, that land's own (land_partner_shares). Same row shape for both.
const SHARE_COLUMNS = `m.full_name, m.member_type, m.phone, m.photo`;

export const siteShareRows = (siteId) => pool.query(
  `SELECT sps.id, sps.member_id, sps.share_pct::float AS share_pct, sps.notes, ${SHARE_COLUMNS}
     FROM site_partner_shares sps JOIN members m ON m.id = sps.member_id
    WHERE sps.site_id = $1
    ORDER BY sps.share_pct DESC, m.full_name ASC`,
  [siteId],
).then(({ rows }) => rows);

export const landShareRows = (farmerIds) => (farmerIds.length ? pool.query(
  `SELECT lps.farmer_id, lps.id, lps.member_id, lps.share_pct::float AS share_pct, lps.notes, ${SHARE_COLUMNS}
     FROM land_partner_shares lps JOIN members m ON m.id = lps.member_id
    WHERE lps.farmer_id = ANY($1::int[])
    ORDER BY lps.share_pct DESC, m.full_name ASC`,
  [farmerIds],
).then(({ rows }) => rows) : Promise.resolve([]));

/**
 * Validate a submitted partner list. Returns { error } or { shares }.
 * Pure so the percentage rules can be exercised without a database.
 */
export const normalizeShares = (incoming) => {
  if (!Array.isArray(incoming)) return { error: 'shares must be an array.' };
  const shares = [];
  for (const row of incoming) {
    const memberId = Number.parseInt(row?.member_id, 10);
    const pct = Number(row?.share_pct);
    if (!Number.isInteger(memberId) || memberId <= 0) return { error: 'Every partner row needs a client.' };
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: 'Each share must be between 0 and 100 percent.' };
    if (shares.some((c) => c.memberId === memberId)) return { error: 'The same client is listed twice.' };
    shares.push({ memberId, pct, notes: String(row?.notes || '').trim().slice(0, 500) || null });
  }
  const total = shares.reduce((sum, c) => sum + c.pct, 0);
  // Tolerance covers thirds (33.33 x 3). Over 100% is always rejected; under
  // 100% is allowed so a partial split can be saved as work in progress.
  if (total > 100.01) return { error: `Shares total ${total.toFixed(2)}% - cannot exceed 100%.` };
  return { shares };
};
