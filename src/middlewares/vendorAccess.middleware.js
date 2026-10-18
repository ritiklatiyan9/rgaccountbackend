import pool from '../config/db.js';
import { assertConstructionSiteAccess, assertConstructionProjectAccess, constructionCanViewAll, projectAccessPredicate } from '../services/constructionWorkflow.service.js';

const id = value => /^\d+$/.test(String(value || '')) && Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : null;
export async function assertVendorCommitmentAccess(db, user, commitmentId, siteId, { lock = false } = {}) {
  await assertConstructionSiteAccess(db, user, siteId);
  const result = await db.query(`SELECT * FROM vendor_commitments WHERE id=$1 AND site_id=$2${lock ? ' FOR UPDATE' : ''}`, [commitmentId, siteId]);
  if (!result.rows[0]) throw Object.assign(new Error('Commitment not found'), { statusCode:404 });
  if (result.rows[0].project_id) await assertConstructionProjectAccess(db,user,result.rows[0].project_id,siteId);
  return result.rows[0];
}

// Resolve the authoritative owner before cached reads or writes. Request site
// values cannot grant access to another site's record. List queries reuse the
// allowed project ids below and retain their existing creator restrictions.
export default async function requireVendorAccess(req,res,next) {
  try {
    const supplied = req.query.site_id ?? req.body?.site_id;
    let siteId=id(supplied), rows=[], match;
    if (supplied !== undefined && !siteId) return res.status(400).json({message:'Invalid site_id'});
    const path=req.path;
    if ((match=/^\/payments\/(\d+)(?:\/(?:receipt|ledger))?$/.exec(path))) {
      rows=(await pool.query('SELECT vp.site_id,vc.project_id FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id WHERE vp.id=$1',[match[1]])).rows;
    } else if ((match=/^\/commitments\/(\d+)(?:\/.*)?$/.exec(path))) {
      rows=(await pool.query('SELECT site_id,project_id FROM vendor_commitments WHERE id=$1',[match[1]])).rows;
    } else if ((match=/^\/heads\/(\d+)$/.exec(path))) {
      rows=(await pool.query('SELECT site_id,NULL::int project_id FROM vendor_heads WHERE id=$1',[match[1]])).rows;
    } else if ((match=/^\/inventory\/inv-payments\/(\d+)$/.exec(path))) {
      rows=(await pool.query('SELECT ip.site_id,o.project_id FROM vendor_inventory_payments ip JOIN vendor_inventory_orders o ON o.id=ip.order_id WHERE ip.id=$1',[match[1]])).rows;
    } else if ((match=/^\/inventory\/(\d+)(?:\/payments)?$/.exec(path))) {
      rows=(await pool.query('SELECT site_id,project_id FROM vendor_inventory_orders WHERE id=$1',[match[1]])).rows;
    } else if (['/payments/bulk-delete','/commitments/bulk-delete'].includes(path)) {
      const ids=req.body?.ids;
      if (!Array.isArray(ids)||!ids.length||ids.some(value=>!id(value))) return res.status(400).json({message:'Valid ids are required'});
      const table=path.startsWith('/payments')?'vendor_payments':'vendor_commitments';
      rows=(await pool.query(table==='vendor_payments'
        ? 'SELECT vp.site_id,vc.project_id FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id WHERE vp.id=ANY($1::int[])'
        : 'SELECT site_id,project_id FROM vendor_commitments WHERE id=ANY($1::int[])',[ids])).rows;
      if (rows.length!==new Set(ids.map(Number)).size) return res.status(404).json({message:'A selected record was not found'});
    }
    for (const row of rows) {
      if (siteId && Number(row.site_id)!==siteId) return res.status(404).json({message:'Record not found for this site'});
      siteId=Number(row.site_id);
      await assertConstructionSiteAccess(pool,req.user,siteId);
      if (row.project_id) await assertConstructionProjectAccess(pool,req.user,row.project_id,siteId);
    }
    if (!siteId) return res.status(400).json({message:'site_id is required'});
    await assertConstructionSiteAccess(pool,req.user,siteId);
    if(req.body?.project_id) await assertConstructionProjectAccess(pool,req.user,req.body.project_id,siteId);
    if(req.query.project_id) await assertConstructionProjectAccess(pool,req.user,req.query.project_id,siteId);
    if(req.user.role==='sub_admin') {
      const all=await constructionCanViewAll(pool,req.user);
      req.vendorProjectIds=(await pool.query(`SELECT p.id FROM construction_projects p WHERE p.site_id=$1 AND ${projectAccessPredicate('p','$2','$3')}`,[siteId,req.user.id,all])).rows.map(row=>row.id);
    }
    req.query.site_id=String(siteId);
    next();
  }catch(error){next(error);}
}
