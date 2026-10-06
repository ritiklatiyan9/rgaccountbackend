import { writeFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { getSiteBalanceDetail } from '../src/graphql/services/kpi.service.js';

// Evidence only: no financial records are changed. Use one repeatable snapshot.
const db = await pool.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [clock] } = await db.query("SELECT now() AS checked_at, ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)::text AS cutoff");
  const { rows: sites } = await db.query('SELECT id, name FROM sites ORDER BY id');
  const report = { ...clock, sites: [] };
  for (const site of sites) {
    const balances = await getSiteBalanceDetail(site.id, '1900-01-01', clock.cutoff, db);
    const { rows: holders } = await db.query(`SELECT il.user_id, u.name, u.role, SUM(il.amount)::numeric AS posted_balance
      FROM imprest_ledger il JOIN users u ON u.id=il.user_id
      WHERE il.site_id=$1 GROUP BY il.user_id,u.name,u.role ORDER BY SUM(il.amount) DESC`, [site.id]);
    const { rows: allocations } = await db.query(`SELECT ia.*, giver.name AS giver_name, recipient.name AS recipient_name,
      (SELECT COUNT(*) FROM imprest_ledger il WHERE il.site_id=ia.site_id AND il.user_id=ia.sub_admin_id AND il.reference_id=ia.id AND il.type='ALLOCATION') AS allocation_postings
      FROM imprest_allocations ia JOIN users giver ON giver.id=ia.admin_id JOIN users recipient ON recipient.id=ia.sub_admin_id
      WHERE ia.site_id=$1 ORDER BY ia.created_at,ia.id`, [site.id]);
    const { rows: requests } = await db.query(`SELECT r.*,u.name AS requester_name FROM imprest_expense_requests r
      JOIN users u ON u.id=r.sub_admin_id WHERE r.site_id=$1 AND r.status='PENDING' ORDER BY r.id`, [site.id]);
    const { rows: returns } = await db.query('SELECT * FROM imprest_returns WHERE site_id=$1 ORDER BY id', [site.id]);
    const { rows: adjustments } = await db.query(`SELECT il.*,u.name AS holder_name FROM imprest_ledger il
      JOIN users u ON u.id=il.user_id WHERE il.site_id=$1 AND il.type='ADJUSTMENT' ORDER BY il.id`, [site.id]);
    report.sites.push({ ...site, balances, holders, allocations, pending_requests: requests, returns, adjustments });
  }
  await db.query('COMMIT');
  const target = process.argv[2] || '../reports/imprest-funding-audit-2026-10-06.json';
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ checked_at: report.checked_at, sites: report.sites.map(s => ({id:s.id,name:s.name,
    cash:s.balances.cashBalance,bank:s.balances.bankBalance,staff:s.balances.imprestHeld,
    pending:s.balances.pendingImprestReservations,available:s.balances.distributableBalance,
    pendingRequests:s.pending_requests.length,
    allocations:s.allocations.map(a=>({id:a.id,to:a.recipient_name,from:a.giver_name,amount:a.amount,status:a.status,
      remark:a.remark,confirmation:a.confirmation_remark,snapshot:a.site_balance_at_allocation,own:a.from_own_float,
      created:a.created_at,confirmed:a.confirmed_at,postings:a.allocation_postings})),
    holders:s.holders.filter(h=>Number(h.posted_balance)!==0),returns:s.returns.map(r=>({id:r.id,amount:r.amount,status:r.status}))
  }))}, null, 2));
} catch (error) { await db.query('ROLLBACK'); throw error; }
finally { db.release(); await pool.end(); }
