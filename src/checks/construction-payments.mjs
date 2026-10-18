import pool from '../config/db.js';
import { expenseModel } from '../models/Expense.model.js';
import { getConstructionSummaryData } from '../controllers/construction.controller.js';

// Always read-only, including when a future model gains an incidental write.
// --preflight runs the legacy-compatible duplicate probes before migrations.
const preflight = process.argv.includes('--preflight');
const client = await pool.connect();
let failures = 0;
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='30s'");
  const probes = await client.query(`
    SELECT 'duplicate_vendor_mirrors' AS check_name,COUNT(*)::int AS groups FROM (
      SELECT source_id FROM cash_flow_entries WHERE source_module='vendor_payments' GROUP BY source_id HAVING COUNT(*)>1) q
    UNION ALL SELECT 'linked_inventory_mirrors',COUNT(*)::int FROM cash_flow_entries c
      JOIN vendor_inventory_payments v ON c.source_module='vendor_inventory_payments' AND c.source_id=v.id WHERE v.source_vendor_payment_id IS NOT NULL
    UNION ALL SELECT 'linked_daybook_mirrors',COUNT(*)::int FROM cash_flow_entries c
      JOIN day_book d ON c.source_module='day_book' AND c.source_id=d.id WHERE d.vendor_payment_id IS NOT NULL
    UNION ALL SELECT 'missing_vendor_mirrors',COUNT(*)::int FROM vendor_payments v
      WHERE NOT EXISTS(SELECT 1 FROM cash_flow_entries c WHERE c.source_module='vendor_payments' AND c.source_id=v.id)
    UNION ALL SELECT 'repeated_vendor_fingerprints',COUNT(*)::int FROM (
      SELECT site_id,commitment_id,payment_date,amount,payment_mode,COALESCE(reference_no,'') FROM vendor_payments
      GROUP BY 1,2,3,4,5,6 HAVING COUNT(*)>1) q`);
  console.table(probes.rows);
  failures += probes.rows.filter(row => row.groups > 0).length;
  const overlaps = await client.query(`SELECT COUNT(*)::int AS possible_matches,COALESCE(SUM(v.amount),0)::text AS vendor_amount
    FROM vendor_payments v JOIN vendor_commitments c ON c.id=v.commitment_id
    WHERE EXISTS(SELECT 1 FROM expenses e WHERE e.site_id=v.site_id AND e.date=v.payment_date
      AND e.debit=v.amount AND UPPER(TRIM(COALESCE(e.to_entity,'')))=UPPER(TRIM(c.vendor_name))
      AND ledger_bucket(e.payment_mode)=ledger_bucket(v.payment_mode))`);
  console.log('Cross-module lookalikes (review only; not proof of duplication):', overlaps.rows[0]);
  if (!preflight) {
    const { rows: sites } = await client.query('SELECT id,organization_id FROM sites ORDER BY id');
    for (const site of sites) {
      const scope = { only_site:'true',include_vendor:true,vendor_all:true,vendor_site_all:true,vendor_rows_all:true,vendor_user_id:1,vendor_only:true };
      const expense = await expenseModel.findPaginatedUnified(site.id,scope,1,0,client);
      const canonical = (await client.query(`SELECT COALESCE(SUM(debit),0)::text AS debit,COALESCE(SUM(credit),0)::text AS credit
        FROM ledger_entries WHERE site_id=$1 AND source_key='vendor_payments' AND ledger_type='site'`,[site.id])).rows[0];
      const { summary } = await getConstructionSummaryData({siteId:site.id,user:{id:1,role:'super_admin',organization_id:site.organization_id}},client);
      const result = (await client.query(`SELECT $1::numeric=$2::numeric AND $3::numeric=$4::numeric AS expenses_match,
        $5::numeric=(SELECT COALESCE(SUM(le.debit-le.credit),0) FROM ledger_entries le
          JOIN vendor_payments vp ON vp.id=le.source_id JOIN vendor_commitments vc ON vc.id=vp.commitment_id
          WHERE le.site_id=$6 AND le.source_key='vendor_payments' AND le.ledger_type='site' AND vc.project_id IS NOT NULL) AS projects_match`,
      [expense.summary.total_debit,canonical.debit,expense.summary.total_credit,canonical.credit,summary.paid_amount,site.id])).rows[0];
      if (!result.expenses_match || !result.projects_match) failures++;
      console.log(`site ${site.id}: Expenses/ledger ${result.expenses_match?'PASS':'FAIL'}; project dashboard/ledger ${result.projects_match?'PASS':'FAIL'}`);
    }
  }
  await client.query('ROLLBACK');
} finally { client.release(); await pool.end(); }
if (failures) process.exitCode=1;
