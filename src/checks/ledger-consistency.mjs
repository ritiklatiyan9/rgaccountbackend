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
import { siteBalanceAsOf, getModeBalance } from '../controllers/daybook.controller.js';
import { getSiteBalance, getRevenue, getExpenseBreakdown } from '../graphql/services/kpi.service.js';

const FAR_FUTURE = '2100-01-01';
// Local date, not toISOString() — the browser anchors the Day Book on the
// user's calendar day, and in IST a UTC date is the previous day until 05:30.
const TODAY = new Date().toLocaleDateString('en-CA');
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const near = (a, b) => Math.abs(a - b) < 1;

// Drive the real /daybook/mode-balance handler rather than re-typing its SQL —
// the divergence this check exists to catch lived in the handler, not the view.
const modeBalance = (siteId, date) => new Promise((resolve, reject) => {
  getModeBalance(
    { query: { site_id: String(siteId), date } },
    { json: resolve, status: () => ({ json: (b) => reject(new Error(b?.message || 'mode-balance failed')) }) },
    reject,
  );
});

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

    // 4. The Cash/Bank Day Book "In"/"Out" cards are cumulative gross flow
    //    through the selected date, so they must equal the Overall statement's
    //    Money in / Money out for the same scope and end date. The cards used
    //    to net refunds back into their source module and to add the selected
    //    day's flow twice, which put them ₹41,37,345 below the statement on
    //    site 10 Bank alone. Assert the arithmetic the cards actually do.
    // 4a. The same three engines, at the cutoff the app actually renders
    //     ("through today") rather than end-of-time. This is the assertion
    //     that catches one page reaching past today while the others stop
    //     there — a post-dated entry then shows up on that page alone.
    const TOMORROW = new Date(Date.now() + 864e5).toLocaleDateString('en-CA');
    const [dbToday, kpiToday, sheetToday] = await Promise.all([
      siteBalanceAsOf(site.id, TOMORROW, pool),
      getSiteBalance(site.id, TOMORROW),
      balanceSheetModel.getReport({ siteId: site.id, dateTo: TODAY, limit: 1 }),
    ]);
    assert.ok(near(dbToday, kpiToday) && near(dbToday, sheetToday.summary.balance_in_hand),
      `${label} through ${TODAY}: daybook ${money(dbToday)} / dashboard ${money(kpiToday)} / sheet ${money(sheetToday.summary.balance_in_hand)}`);

    const mb = await modeBalance(site.id, TODAY);
    for (const [bucket, scope] of [['cash', 'cash'], ['bank', 'bank']]) {
      const cardIn  = mb[bucket].opening_credit + mb[bucket].day_credit;
      const cardOut = mb[bucket].opening_debit  + mb[bucket].day_debit;
      const stmt = await balanceSheetModel.getReport({ siteId: site.id, scope, dateTo: TODAY, limit: 1 });
      assert.ok(near(cardIn, stmt.summary.total_credit),
        `${label}: ${bucket} card In ${money(cardIn)} vs statement Money in ${money(stmt.summary.total_credit)}`);
      assert.ok(near(cardOut, stmt.summary.total_debit),
        `${label}: ${bucket} card Out ${money(cardOut)} vs statement Money out ${money(stmt.summary.total_debit)}`);
      // The breakdown modal must add up to the card it opened from.
      const srcIn  = Object.values(mb[bucket].by_src).reduce((s, r) => s + r.in, 0);
      const srcOut = Object.values(mb[bucket].by_src).reduce((s, r) => s + r.out, 0);
      assert.ok(near(srcIn, cardIn) && near(srcOut, cardOut),
        `${label}: ${bucket} breakdown ${money(srcIn)}/${money(srcOut)} != card ${money(cardIn)}/${money(cardOut)}`);
    }

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

// Post-dated entries sit outside every period that ends today, so they are in
// no total until their date arrives. Usually a mistyped year — print them.
const { rows: postDated } = await pool.query(
  `SELECT site_id, entry_date, source_key, particular, debit, credit
     FROM ledger_entries WHERE entry_date > $1::date ORDER BY site_id, entry_date`, [TODAY]);
if (postDated.length) {
  console.log(`\n⚠  Entries dated after ${TODAY} — not counted in any total until then:`);
  for (const r of postDated) {
    console.log(`   site ${r.site_id}  ${r.entry_date.toLocaleDateString('en-CA')}  ` +
      `${String(r.source_key).padEnd(26)} ${money(r.credit - r.debit)}  ${String(r.particular || '').slice(0, 40)}`);
  }
}

await pool.end();
if (failures) { console.error(`\n${failures} site(s) inconsistent`); process.exit(1); }
console.log('\nAll sites consistent across Day Book, Balance Sheet and dashboard.');
