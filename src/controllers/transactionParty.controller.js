import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import permissionModel from '../models/Permission.model.js';
import { SIGN_TARGETS, requireTargetSiteAccess } from './signature.controller.js';

/**
 * "Money Related To" — which client a transaction was about.
 *
 * A HINT, NEVER A POSTING. The stored row has no amount, mode or status, so no
 * ledger, balance or module total reads it; linking or unlinking a client can
 * not move money or double-count anything.
 *
 * Targets reuse the signature registry (target → table + permission + owning
 * site lookup) so a module is wired up in one place instead of two.
 */
export const PARTY_TARGETS = {
  ...SIGN_TARGETS,
  misc_income_entry: {
    table: 'misc_income_entries',
    perm: 'misc_income',
    siteQuery: 'SELECT site_id FROM misc_income_entries WHERE id = $1 LIMIT 1',
  },
};

const DIRECTIONS = new Set(['credit', 'debit']);

// Guard against a runaway payload if a site ever maps tens of thousands of
// rows. ponytail: whole-site fetch, paginate if a real site ever nears this
// ceiling.
const MAX_LINKS = 20000;

const positiveId = (value) => {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

/** Drop the targets this user may not read, instead of failing the whole page. */
const readableTargets = async (user, keys) => {
  if (ADMIN_ROLES.has(user?.role)) return keys;
  const verdicts = await Promise.all(keys.map(async (key) => {
    const target = PARTY_TARGETS[key];
    if (target.adminOnly) return null;
    const permission = await permissionModel.getPermission(user.id, target.perm);
    return permission?.can_read === true ? key : null;
  }));
  return verdicts.filter(Boolean);
};

/**
 * GET /transaction-parties?site_id=X&targets=expense,daybook
 * One request per table — even a Day Book that mixes modules. Returns a sparse
 * map keyed "target:rowId"; unmapped rows simply are not in it.
 */
export const listPartyLinks = asyncHandler(async (req, res) => {
  const siteId = positiveId(req.query.site_id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const requested = String(req.query.targets || '').split(',').map((key) => key.trim()).filter(Boolean);
  if (!requested.length) return res.status(400).json({ message: 'targets is required' });
  const unknown = requested.find((key) => !PARTY_TARGETS[key]);
  if (unknown) return res.status(400).json({ message: `Unknown transaction target: ${unknown}` });

  const keys = await readableTargets(req.user, [...new Set(requested)]);
  if (!keys.length) return res.json({ links: {} });

  const { rows } = await pool.query(
    `SELECT l.source_key, l.source_id, l.member_id, l.direction, m.full_name, m.phone
       FROM transaction_party_links l
       JOIN members m ON m.id = l.member_id
      WHERE l.source_key = ANY($1::varchar[]) AND l.site_id = $2
      LIMIT ${MAX_LINKS}`,
    [keys, siteId]
  );

  const links = {};
  for (const row of rows) {
    links[`${row.source_key}:${row.source_id}`] = {
      member_id: row.member_id, name: row.full_name, phone: row.phone, direction: row.direction,
    };
  }
  res.json({ links });
});

/**
 * PUT /transaction-parties/:target/:id
 * Body: { member_id, direction } — member_id null/'' clears the link.
 */
export const savePartyLink = asyncHandler(async (req, res) => {
  const targetKey = req.params.target;
  const target = PARTY_TARGETS[targetKey];
  if (!target) return res.status(400).json({ message: 'Unknown transaction target' });
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid id' });

  const record = await requireTargetSiteAccess(req, res, target, id);
  if (!record) return undefined;

  const raw = req.body?.member_id;
  if (raw === null || raw === undefined || raw === '') {
    await pool.query(
      'DELETE FROM transaction_party_links WHERE source_key = $1 AND source_id = $2',
      [targetKey, id]
    );
    return res.json({ message: 'Link cleared', link: null });
  }

  const memberId = positiveId(raw);
  if (!memberId) return res.status(400).json({ message: 'Invalid client' });
  const direction = String(req.body?.direction || '').toLowerCase();
  if (!DIRECTIONS.has(direction)) return res.status(400).json({ message: 'direction must be credit or debit' });

  const siteId = positiveId(record.site_id);
  if (!siteId) return res.status(409).json({ message: 'This entry is not linked to a site' });

  // Same-site only: a picker can never attach another site's client.
  const { rows: memberRows } = await pool.query(
    'SELECT id, full_name, phone FROM members WHERE id = $1 AND site_id = $2',
    [memberId, siteId]
  );
  if (!memberRows[0]) return res.status(409).json({ message: 'Choose a client from the same site as this entry' });

  await pool.query(
    `INSERT INTO transaction_party_links (source_key, source_id, site_id, member_id, direction, created_by)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source_key, source_id) DO UPDATE
        SET member_id = EXCLUDED.member_id, direction = EXCLUDED.direction, updated_at = NOW()`,
    [targetKey, id, siteId, memberId, direction, req.user?.id || null]
  );

  return res.json({
    message: 'Linked',
    link: { member_id: memberId, name: memberRows[0].full_name, phone: memberRows[0].phone, direction },
  });
});
