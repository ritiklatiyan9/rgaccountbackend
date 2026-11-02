// Read-only, organization-scoped wallet audit. Real financial records are
// written only to the explicitly chosen local report, never to PostgreSQL.
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pool from '../src/config/db.js';
import { walletUser, positiveId } from '../src/services/wallet.service.js';
import { walletReadTransaction } from '../src/services/walletRead.service.js';
import { siteVaultAccountsCte } from '../src/services/loyaltyVaultSite.service.js';
import { adminWalletCashStates, walletWithCashInHand } from '../src/services/adminWalletCash.service.js';
import { addHolderWalletActivity } from '../src/services/walletCashDeductions.service.js';
import { verifyWalletSiteProjection } from '../src/migrations/234_wallet_site_projection.js';

export async function auditWalletReconciliation(database, actorId) {
  const actor = await walletUser({ id: positiveId(actorId) }, database);
  if (!['admin', 'super_admin'].includes(actor.role)) throw new Error('An active organization administrator is required for an all-site audit.');
  const sites = (await database.query('SELECT id,name,include_in_overall FROM sites WHERE organization_id=$1 ORDER BY id', [actor.organization_id])).rows;
  const result = { checked_at: new Date().toISOString(), organization_id: actor.organization_id, read_only: true,
    includes_overall_disabled_sites: true, sites: [], ledger_cache_mismatches: [], transfer_mismatches: [] };
  for (const site of sites) {
    const began = performance.now();
    const data = await walletReadTransaction(database, async db => {
      const holders = (await db.query(`WITH ${siteVaultAccountsCte('$1', '$2', { projection: false })}
        SELECT u.id AS holder_id,'user' AS holder_type,u.name,u.role,COALESCE(a.balance,0)::text AS balance,
          COALESCE(a.total_received,0)::text AS total_received,COALESCE(a.total_handover,0)::text AS total_handover,
          COALESCE(a.total_adjustments,0)::text AS total_adjustments,COALESCE(a.total_imprest_out,0)::text AS total_imprest_out
        FROM users u LEFT JOIN site_accounts a ON a.holder_key='user:'||u.id::text
        WHERE u.organization_id=$1 AND (a.holder_key IS NOT NULL OR (u.is_active AND
          (u.role IN ('admin','super_admin') OR EXISTS(SELECT 1 FROM user_sites us WHERE us.user_id=u.id AND us.site_id=$2))))
        ORDER BY u.id`, [actor.organization_id, site.id])).rows;
      const states = await adminWalletCashStates(actor.organization_id, site.id, db, null, { includeDeductions: true });
      const visible = holders.map(row => walletWithCashInHand(row, states));
      await addHolderWalletActivity(db, { organizationId: actor.organization_id, siteId: site.id, holders: visible });
      const corrections = (await db.query(`WITH corrections AS (
        SELECT e.* FROM loyalty_vault_entries e LEFT JOIN application_settings a
          ON a.site_id=e.site_id AND a.setting_key='wallet_reporting_opening:'||e.holder_key
        WHERE e.organization_id=$1 AND e.site_id=$2 AND e.kind='adjustment'
          AND e.created_at>=COALESCE(NULLIF(a.setting_value->>'started_at','')::timestamptz,'1900-01-01'::timestamptz)
      ) SELECT e.id::text AS wallet_entry_id,e.holder_key,e.amount::text,e.source_table,e.source_id,
        e.cash_flow_entry_id,e.description,e.created_at,e.details->>'remarks' AS remarks,
        p.details->>'credit' AS previous_credit,e.details->>'credit' AS current_credit
        FROM corrections e LEFT JOIN LATERAL (
          SELECT prior.details FROM loyalty_vault_entries prior WHERE prior.organization_id=e.organization_id
            AND prior.site_id=e.site_id AND prior.holder_key=e.holder_key AND prior.id<e.id
            AND prior.source_table=e.source_table AND prior.source_id=e.source_id
          ORDER BY prior.id DESC LIMIT 1
        ) p ON true ORDER BY e.id`, [actor.organization_id, site.id])).rows;
      return { ...site, holders: visible.map(row => ({ holder_id: row.holder_id, name: row.name, role: row.role,
        balance: row.balance, basis: row.cash_in_hand_basis || 'RECORDED_WALLET', activity: row.cash_deductions })), corrections };
    }, { repeatableRead: true });
    result.sites.push({ ...data, audit_elapsed_ms: Math.round((performance.now() - began) * 100) / 100 });
  }
  await walletReadTransaction(database, async db => {
    if ((await db.query("SELECT to_regclass('loyalty_vault_site_accounts') IS NOT NULL AS installed")).rows[0].installed) {
      result.site_projection_verification = await verifyWalletSiteProjection(db);
    }
    result.ledger_cache_mismatches = (await db.query(`WITH ledger AS (
      SELECT holder_key,sum(amount) AS balance FROM loyalty_vault_entries WHERE organization_id=$1 GROUP BY holder_key
    ) SELECT a.holder_key,a.balance::text AS cached_balance,COALESCE(l.balance,0)::text AS ledger_balance
      FROM loyalty_vault_accounts a LEFT JOIN ledger l USING(holder_key)
      WHERE a.organization_id=$1 AND a.balance IS DISTINCT FROM COALESCE(l.balance,0)`, [actor.organization_id])).rows;
    result.transfer_mismatches = (await db.query(`SELECT t.id,t.site_id,t.amount::text,count(e.id)::int AS posting_count,
      COALESCE(sum(e.amount),0)::text AS posting_net FROM loyalty_vault_transfers t
      LEFT JOIN loyalty_vault_entries e ON e.transfer_id=t.id AND e.organization_id=t.organization_id
      WHERE t.organization_id=$1 AND t.status='accepted' GROUP BY t.id
      HAVING count(e.id)<>2 OR COALESCE(sum(e.amount),0)<>0
        OR COALESCE(sum(e.amount) FILTER(WHERE e.kind='transfer_out' AND e.holder_type=t.from_holder_type AND e.holder_id=t.from_holder_id),0)<>-t.amount
        OR COALESCE(sum(e.amount) FILTER(WHERE e.kind='transfer_in' AND e.holder_type='user' AND e.holder_id=t.to_holder_id),0)<>t.amount`, [actor.organization_id])).rows;
  }, { repeatableRead: true });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--actor') || !args.includes('--output')) throw new Error('Usage: node scripts/audit-wallet-reconciliation.mjs --actor <admin-id> --output <local-report.json>');
  try {
    const report = await auditWalletReconciliation(pool, value('--actor'));
    await writeFile(value('--output'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ report: value('--output'), site_count: report.sites.length,
      holder_count: report.sites.reduce((n, site) => n + site.holders.length, 0),
      ledger_cache_mismatches: report.ledger_cache_mismatches.length, transfer_mismatches: report.transfer_mismatches.length,
      sites: report.sites.map(site => ({ id: site.id, name: site.name, include_in_overall: site.include_in_overall,
        nonzero_reconciliations: site.holders.filter(row => row.activity?.cash_adjustment && !/^0(?:\.0+)?$/.test(row.activity.cash_adjustment)).map(row => ({
          holder_id: row.holder_id, name: row.name, amount: row.activity.cash_adjustment, corrections: row.activity.reconciliation?.wallet_corrections,
          remaining: row.activity.reconciliation?.other_cash_changes,
        })) })) }));
  } finally { await pool.end(); }
}
