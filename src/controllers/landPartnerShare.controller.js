import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { landShareRows, normalizeShares } from '../services/partnerShares.service.js';

const parseFarmer = (value) => { const id = Number.parseInt(value, 10); return Number.isInteger(id) && id > 0 ? id : null; };

/** GET /land-deals/land/:farmerId/partners — this land's own split ([] = follows the site split). */
export const getLandPartnerShares = asyncHandler(async (req, res) => {
  const farmerId = parseFarmer(req.params.farmerId);
  if (!farmerId) return res.status(400).json({ message: 'A valid land is required.' });
  res.json({ farmerId, shares: await landShareRows([farmerId]) });
});

/** PUT /land-deals/land/:farmerId/partners — replace the land's split. Send [] to follow the site split again. */
export const saveLandPartnerShares = asyncHandler(async (req, res) => {
  const farmerId = parseFarmer(req.params.farmerId);
  if (!farmerId) return res.status(400).json({ message: 'A valid land is required.' });
  const { rows: [land] } = await pool.query('SELECT id, site_id FROM farmers WHERE id = $1', [farmerId]);
  if (!land) return res.status(404).json({ message: 'Land not found.' });
  const { error, shares } = normalizeShares(req.body?.shares);
  if (error) return res.status(400).json({ message: error });
  if (shares.length) {
    const { rows } = await pool.query('SELECT id FROM members WHERE site_id = $1 AND id = ANY($2::int[])', [land.site_id, shares.map((s) => s.memberId)]);
    if (rows.length !== shares.length) return res.status(400).json({ message: "Every partner must be a member of this land's site." });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM land_partner_shares WHERE farmer_id = $1', [farmerId]);
    for (const s of shares) {
      await client.query(
        `INSERT INTO land_partner_shares (farmer_id, member_id, share_pct, notes, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)`,
        [farmerId, s.memberId, s.pct, s.notes, req.user?.id ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ farmerId, shares: await landShareRows([farmerId]) });
});
