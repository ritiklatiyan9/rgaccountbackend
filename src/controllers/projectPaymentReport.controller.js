import asyncHandler from '../utils/asyncHandler.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { getPlotsWithTotals } from '../graphql/services/plotPayments.service.js';
import pool from '../config/db.js';

// Reuse the payment register's projection so installment receipts, cheque
// posting, registry coverage and sale targets stay consistent with that page.
export const projectPaymentReport = asyncHandler(async (req, res) => {
  // Use the same decimal identity as the site-access middleware. Number()
  // alone accepts hex/exponent strings that parseInt() scopes differently.
  const siteId = !Array.isArray(req.query.site_id) && /^\d+$/.test(String(req.query.site_id || ''))
    ? Number(req.query.site_id) : NaN;
  if (!Number.isSafeInteger(siteId) || siteId <= 0 || siteId > 2147483647) {
    return res.status(400).json({ message: 'A valid site_id is required.' });
  }
  const visibility = await resolveEntryVisibility(req.user, 'plot_payments', req.query.created_by);
  if (visibility.creatorId === -1) return res.status(400).json({ message: 'Choose valid entry users.' });
  const [plots, members] = await Promise.all([
    getPlotsWithTotals(siteId, visibility.creatorId),
    pool.query('SELECT full_name AS name, team FROM members WHERE site_id = $1 AND team IS NOT NULL ORDER BY id', [siteId]),
  ]);
  res.json({ plots, members: members.rows, generated_at: new Date().toISOString(), receipt_scope: visibility.creatorId == null ? 'all' : 'creator' });
});
