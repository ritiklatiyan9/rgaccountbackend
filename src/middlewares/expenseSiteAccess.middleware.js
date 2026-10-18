import pool from '../config/db.js';

// Module permission and site membership are independent. Resolve detail IDs
// against their owning source rather than trusting a supplied site_id.
export default async function expenseSiteAccess(req, res, next) {
  try {
    if (req.params.id != null && !/^[1-9]\d*$/.test(String(req.params.id))) return res.status(400).json({ message: 'Invalid expense id' });
    let site = req.query.site_id ?? req.body?.site_id;
    if (site != null && !/^[1-9]\d*$/.test(String(site))) return res.status(400).json({ message: 'Invalid site_id' });
    if (['admin', 'super_admin'].includes(req.user?.role)) return next();
    if (/^\d+$/.test(String(req.params.id || ''))) {
      const table = req.query.source === 'vendor_payment' ? 'vendor_payments' : req.query.source === 'daybook' ? 'day_book' : 'expenses';
      const { rows } = await pool.query(`SELECT site_id FROM ${table} WHERE id=$1`, [req.params.id]);
      if (rows[0]) site = rows[0].site_id;
    }
    if (!/^\d+$/.test(String(site || ''))) return next();
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2', [req.user.id, site]);
    if (!rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
    return next();
  } catch (error) { return next(error); }
}
