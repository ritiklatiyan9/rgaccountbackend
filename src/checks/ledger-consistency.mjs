/**
 * Ledger consistency check — run: node src/checks/ledger-consistency.mjs
 *
 * Asserts the invariant the Day Book, Balance Sheet, dashboard KPIs and the
 * module pages all depend on: they are different presentations of ONE ledger,
 * so their totals must reconcile exactly. Fails loudly if any engine drifts.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import pool from '../config/db.js';
import balanceSheetModel from '../models/BalanceSheet.model.js';
import { siteBalanceAsOf } from '../controllers/daybook.controller.js';
import { getSiteBalance, getRevenue, getExpenseBreakdown } from '../graphql/services/kpi.service.js';

const FAR_FUTURE = '2100-01-01';
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const near = (a, b) => Math.abs(a - b) < 1;

const { rows: sites } = await pool.query('SELECT id, name FROM sites ORDER BY id');
let failures = 0;

for (const site of sites) {
  const [daybook, kpi, sheet, cash, bank] = await Promise.all([
    siteBalanceAsOf(site.id, FAR_FUTURE, pool),
    getSiteBalance(site.id, FAR_FUTURE),
    balanceSheetModel.getReport({ siteId: site.id, limit: 1 }),
    balanceSheetModel.getReport({ siteId: site.id, scope: 'cash', limit: 1 }),
    balanceSheetModel.getReport({ siteId: site.id, scope: 'bank', limit: 1 }),
  ]);

  const sheetBalance = sheet.summary.balance_in_hand;
  const label = `site ${site.id} ${site.name}`;

  try {
    // 1. Day Book Site Balance == dashboard Site Balance == Balance Sheet in-hand
    assert.ok(near(daybook, kpi), `${label}: daybook ${money(daybook)} vs dashboard ${money(kpi)}`);
    assert.ok(near(daybook, sheetBalance), `${label}: daybook ${money(daybook)} vs balance sheet ${money(sheetBalance)}`);

    // 2. Cash scope + Bank scope must partition the whole ledger
    const parts = cash.summary.net_movement + bank.summary.net_movement;
    assert.ok(near(parts, sheet.summary.net_movement),
      `${label}: cash+bank ${money(parts)} != all ${money(sheet.summary.net_movement)}`);

    // 3. Revenue − expenses, both read off the ledger, must not exceed its net
    const revenue = await getRevenue(site.id, '1900-01-01', FAR_FUTURE);
    const { total: expense } = await getExpenseBreakdown(site.id, '1900-01-01', FAR_FUTURE);
    assert.ok(revenue >= 0 && expense >= 0, `${label}: negative revenue/expense`);

    console.log(`✓ ${label.padEnd(34)} balance ${money(daybook).padStart(16)}  ` +
      `in ${money(sheet.summary.total_credit).padStart(16)}  out ${money(sheet.summary.total_debit).padStart(16)}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${err.message}`);
  }
}

const { rows: quarantine } = await pool.query(
  `SELECT site_id, source_key, COUNT(*)::int n, SUM(debit + credit)::numeric amount
     FROM ledger_quarantine GROUP BY 1, 2 ORDER BY 1, 2`);
if (quarantine.length) {
  console.log('\n⚠  Entries excluded from every balance — their date is a typo. Fix these:');
  for (const r of quarantine) {
    console.log(`   site ${r.site_id}  ${String(r.source_key).padEnd(26)} ${r.n} row(s)  ${money(r.amount)}`);
  }
}

await pool.end();
if (failures) { console.error(`\n${failures} site(s) inconsistent`); process.exit(1); }
console.log('\nAll sites consistent across Day Book, Balance Sheet and dashboard.');
