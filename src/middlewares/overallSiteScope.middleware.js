import pool from '../config/db.js';

// Read the small site directory before cache lookup. A financial portfolio may
// be cached, but its included-site set must always match the live Sites switch.
export const requireOverallSiteScope = async (req, _res, next) => {
  try {
    const subAdminId = req.user?.role === 'sub_admin' ? req.user.id : null;
    const { rows } = await pool.query(`SELECT id FROM sites
      WHERE include_in_overall IS NOT FALSE
        AND ($1::int IS NULL OR EXISTS (
          SELECT 1 FROM user_sites us WHERE us.site_id = sites.id AND us.user_id = $1
        )) ORDER BY id`, [subAdminId]);
    req.overallSiteIds = rows.map(site => Number(site.id));
    // Entry grants can also change in another API process. Fingerprint the live
    // grants already loaded by the route before looking up a cached portfolio.
    const grants = req.user?.permissionsByModule instanceof Map
      ? [...req.user.permissionsByModule].map(([module, row]) => [module, row?.can_read === true, row?.can_view_all === true]) : [];
    req.cacheDataScope = JSON.stringify(['overall-sites', req.overallSiteIds, grants]);
    next();
  } catch (error) { next(error); }
};
