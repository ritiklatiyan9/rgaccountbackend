import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { getAllKpis } from '../graphql/services/kpi.service.js';

// Profit is cumulative-to-date in kpi.service (plot incoming, land book profit
// and running expense all key off `end`), so the start bound is a formality.
const PROFIT_EPOCH = '1900-01-01';
const today = () => new Date().toISOString().slice(0, 10);

const shareRows = (siteId) => pool.query(
  `SELECT sps.id, sps.member_id, sps.share_pct::float AS share_pct, sps.notes,
          m.full_name, m.member_type, m.phone, m.photo
     FROM site_partner_shares sps
     JOIN members m ON m.id = sps.member_id
    WHERE sps.site_id = $1
    ORDER BY sps.share_pct DESC, m.full_name ASC`,
  [siteId],
).then(({ rows }) => rows);

/** GET /sites/:id/profit-shares — live site profit plus the saved partner split. */
export const getSiteProfitShares = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site is required.' });
  }
  // Dashboard shortcuts need identities only, without recomputing all KPIs.
  if (req.query.shares_only === 'true') {
    return res.json({ siteId, shares: await shareRows(siteId) });
  }
  const excludeOldPlots = String(req.query.exclude_old_plots || '') === 'true';
  const [kpis, shares] = await Promise.all([
    getAllKpis(siteId, PROFIT_EPOCH, today(), excludeOldPlots),
    shareRows(siteId),
  ]);
  res.json({
    siteId,
    profit: {
      expectedProfit: kpis.expectedProfit,
      currentProfit: kpis.currentProfit,
      runningExpense: kpis.runningExpense,
      plotIncoming: kpis.plotIncoming,
      landProfitDetail: kpis.landProfitDetail,
    },
    shares,
  });
});

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

/** PUT /sites/:id/profit-shares - replace the whole partner list for one site. */
export const saveSiteProfitShares = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site is required.' });
  }
  const { error, shares: cleaned } = normalizeShares(req.body?.shares);
  if (error) return res.status(400).json({ message: error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM site_partner_shares WHERE site_id = $1', [siteId]);
    for (const c of cleaned) {
      await client.query(
        `INSERT INTO site_partner_shares (site_id, member_id, share_pct, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [siteId, c.memberId, c.pct, c.notes, req.user?.id ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return res.status(400).json({ message: 'A selected client no longer exists.' });
    throw err;
  } finally {
    client.release();
  }
  res.json({ siteId, shares: await shareRows(siteId) });
});
