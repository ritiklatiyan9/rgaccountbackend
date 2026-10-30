import pool from '../config/db.js';

// Read the small site directory before cache lookup. A financial portfolio may
// be cached, but its included-site set must always match the live Sites switch.
export const requireOverallSiteScope = async (req, _res, next) => {
  try {
    const { rows } = await pool.query('SELECT id FROM sites WHERE include_in_overall IS NOT FALSE ORDER BY id');
    req.overallSiteIds = rows.map(site => Number(site.id));
    req.cacheDataScope = `overall-sites:${req.overallSiteIds.join(',')}`;
    next();
  } catch (error) { next(error); }
};
