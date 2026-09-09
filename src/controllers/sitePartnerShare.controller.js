import { partnerPaidByMember, paymentPartners } from '../services/partnerPayments.service.js';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { getProfitKpis } from '../graphql/services/kpi.service.js';
import { landShareRows, normalizeShares as normalizeSharesRule, siteShareRows } from '../services/partnerShares.service.js';

// Profit is cumulative-to-date in kpi.service (plot incoming, land book profit
// and running expense all key off `end`). `end` is EXCLUSIVE — the Dashboard passes
// tomorrow (local date) so today's entries count; passing today silently dropped them.
const cutoff = () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const shareRows = siteShareRows;

/** GET /sites/:id/profit-shares — live site profit plus the saved partner split. */
export const getSiteProfitShares = asyncHandler(async (req, res) => {
  const siteId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    return res.status(400).json({ message: 'A valid site is required.' });
  }
  // Dashboard shortcuts need identities only, without recomputing all KPIs.
  if (req.query.shares_only === 'true') {
    return res.json({ siteId, shares: await paymentPartners(siteId) });
  }
  const excludeOldPlots = String(req.query.exclude_old_plots || '') === 'true';
  const end = cutoff();
  const [kpis, shares, payments] = await Promise.all([
    getProfitKpis(siteId, end, excludeOldPlots),
    shareRows(siteId),
    partnerPaidByMember(siteId, end),
  ]);
  // Each land carries its own split when one is saved; an empty list means it follows the site split.
  const landSplits = await landShareRows(kpis.lands.map((land) => land.farmer_id));
  res.json({
    siteId,
    payments,
    profit: {
      expectedProfit: kpis.expectedProfit,
      currentProfit: kpis.currentProfit,
      runningExpense: kpis.runningExpense,
      plotIncoming: kpis.plotIncoming,
      landProfitDetail: kpis.landProfitDetail,
      plot: kpis.plot,
      land: kpis.land,
    },
    lands: kpis.lands.map((land) => ({ ...land, shares: landSplits.filter((split) => split.farmer_id === land.farmer_id) })),
    shares,
  });
});

export const normalizeShares = normalizeSharesRule;

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
