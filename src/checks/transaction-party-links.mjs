/**
 * "Money Related To" check — run: node src/checks/transaction-party-links.mjs
 *
 * The whole promise of this feature is that mapping a transaction to a client
 * is a NOTE, not a posting: it must never move, net or double-count money. So
 * this check links and unlinks a real row inside a rolled-back transaction and
 * asserts that `ledger_entries` — the single source every total reads — does
 * not budge by a single paisa, and that the guards around the link hold.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import pool from '../config/db.js';
import { PARTY_TARGETS } from '../controllers/transactionParty.controller.js';
import { expenseModel } from '../models/Expense.model.js';

const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const ledgerTotals = async (db, siteId) => {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS rows, COALESCE(SUM(debit), 0)::numeric AS debit,
            COALESCE(SUM(credit), 0)::numeric AS credit
       FROM ledger_entries WHERE site_id = $1`,
    [siteId]
  );
  return rows[0];
};

const db = await pool.connect();
let failures = 0;
const fail = (message) => { failures += 1; console.error(`  ✗ ${message}`); };

try {
  await db.query('BEGIN');

  // ── Schema ──
  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'transaction_party_links'`
  );
  assert.ok(cols.length, 'transaction_party_links is missing — run migration 166');
  const names = new Set(cols.map((c) => c.column_name));
  for (const needed of ['source_key', 'source_id', 'site_id', 'member_id', 'direction']) {
    assert.ok(names.has(needed), `transaction_party_links.${needed} is missing`);
  }
  // The table must carry nothing that looks like money. If an amount ever
  // lands here, some total will eventually start reading it.
  const moneyish = [...names].filter((c) => /amount|debit|credit|balance|total|paid/.test(c));
  assert.deepEqual(moneyish, [], `party links must hold no money columns, found: ${moneyish}`);
  console.log(`✓ schema: ${cols.length} columns, none monetary`);

  // ── Every target resolves a real row to a real site ──
  for (const [key, target] of Object.entries(PARTY_TARGETS)) {
    try {
      await db.query(target.siteQuery, [0]); // 0 matches nothing; we test the SQL
    } catch (error) {
      fail(`target "${key}" siteQuery is broken: ${error.message}`);
    }
  }
  console.log(`✓ ${Object.keys(PARTY_TARGETS).length} targets resolve their owning site`);

  // ── A real plot payment + a client from its own site ──
  const { rows: sample } = await db.query(
    `SELECT pp.id, pp.site_id, m.id AS member_id
       FROM plot_payments pp
       JOIN members m ON m.site_id = pp.site_id
      WHERE pp.site_id IS NOT NULL
      ORDER BY pp.id DESC LIMIT 1`
  );

  if (!sample[0]) {
    console.log('· no plot payment with a same-site client to exercise — schema checks only');
  } else {
    const { id, site_id: siteId, member_id: memberId } = sample[0];
    const before = await ledgerTotals(db, siteId);

    await db.query(
      `INSERT INTO transaction_party_links (source_key, source_id, site_id, member_id, direction)
            VALUES ('plot_payment', $1, $2, $3, 'credit')
       ON CONFLICT (source_key, source_id) DO UPDATE SET member_id = EXCLUDED.member_id`,
      [id, siteId, memberId]
    );
    const linked = await ledgerTotals(db, siteId);
    if (linked.rows !== before.rows
      || Number(linked.debit) !== Number(before.debit)
      || Number(linked.credit) !== Number(before.credit)) {
      fail(`linking moved the ledger: ${before.rows} rows / ${money(before.debit)} Dr / ${money(before.credit)} Cr`
        + ` → ${linked.rows} rows / ${money(linked.debit)} Dr / ${money(linked.credit)} Cr`);
    } else {
      console.log(`✓ site ${siteId}: linking a client left ${before.rows} ledger rows,`
        + ` ${money(before.debit)} Dr / ${money(before.credit)} Cr unchanged`);
    }

    // Re-linking the same row must replace, never accumulate.
    await db.query(
      `INSERT INTO transaction_party_links (source_key, source_id, site_id, member_id, direction)
            VALUES ('plot_payment', $1, $2, $3, 'debit')
       ON CONFLICT (source_key, source_id) DO UPDATE
          SET member_id = EXCLUDED.member_id, direction = EXCLUDED.direction`,
      [id, siteId, memberId]
    );
    const { rows: dupes } = await db.query(
      `SELECT COUNT(*)::int AS n FROM transaction_party_links WHERE source_key = 'plot_payment' AND source_id = $1`,
      [id]
    );
    if (dupes[0].n !== 1) fail(`re-linking created ${dupes[0].n} rows; the primary key must keep it at 1`);
    else console.log('✓ re-linking the same transaction replaces its hint instead of adding one');

    await db.query(
      `DELETE FROM transaction_party_links WHERE source_key = 'plot_payment' AND source_id = $1`, [id]
    );
    const after = await ledgerTotals(db, siteId);
    if (Number(after.debit) !== Number(before.debit) || Number(after.credit) !== Number(before.credit)) {
      fail('unlinking moved the ledger');
    } else {
      console.log('✓ unlinking left the ledger unchanged');
    }
  }

  // ── The Expenses "Money Related To" filter (server-side) ──
  // Two expenses on one site linked to two different clients: filtering by one
  // returns exactly its expense, filtering by both returns both, and the summary
  // and breakdown describe the same rows the list shows.
  const { rows: pair } = await db.query(`
    SELECT e.site_id, ARRAY_AGG(e.id ORDER BY e.id DESC) AS expense_ids,
           (SELECT ARRAY_AGG(m.id ORDER BY m.id) FROM (SELECT id FROM members WHERE site_id = e.site_id ORDER BY id LIMIT 2) m) AS member_ids
      FROM (SELECT id, site_id, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY id DESC) AS rn FROM expenses) e
     WHERE e.rn <= 2
     GROUP BY e.site_id
    HAVING COUNT(*) = 2 AND (SELECT COUNT(*) FROM members WHERE site_id = e.site_id) >= 2
     LIMIT 1`);
  if (!pair[0]) {
    console.log('· no site with two expenses and two clients — expense filter not exercised');
  } else {
    const { site_id: siteId, expense_ids: [expenseA, expenseB], member_ids: [memberA, memberB] } = pair[0];
    for (const [expenseId, memberId] of [[expenseA, memberA], [expenseB, memberB]]) {
      await db.query(
        `INSERT INTO transaction_party_links (source_key, source_id, site_id, member_id, direction)
              VALUES ('expense', $1, $2, $3, 'debit')
         ON CONFLICT (source_key, source_id) DO UPDATE SET member_id = EXCLUDED.member_id`,
        [expenseId, siteId, memberId]
      );
    }
    // The model runs its queries in parallel; on this single transaction client pg
    // queues them and prints a deprecation warning. Harmless here — the app uses a pool.
    const pageFor = (ids, extra = { only_site: 'true' }) => expenseModel.findPaginatedUnified(
      siteId, { ...extra, related_member_ids: ids }, 1, 0, db
    );
    const idsOf = (page) => page.items.map((row) => Number(row.id)).sort((a, b) => a - b);

    const onlyA = await pageFor([memberA]);
    const both = await pageFor([memberA, memberB]);
    const unified = await pageFor([memberA], {}); // no only_site: still expense rows only
    const breakdown = await expenseModel.getUnifiedBreakdowns(siteId, { only_site: 'true', related_member_ids: [memberA] }, db);
    const breakdownEntries = breakdown.categoryBreakdown.reduce((sum, row) => sum + Number(row.entries), 0);
    const { rows: [posted] } = await db.query(
      `SELECT CASE WHEN financial_transaction_posts('debit', status, payment_mode, cheque_status) THEN COALESCE(debit, 0) ELSE 0 END::numeric AS debit
         FROM expenses WHERE id = $1`, [expenseA]);

    const expectOne = JSON.stringify(idsOf(onlyA)) === JSON.stringify([expenseA]);
    const expectBoth = JSON.stringify(idsOf(both)) === JSON.stringify([expenseA, expenseB].sort((a, b) => a - b));
    if (!expectOne) fail(`client filter returned ${JSON.stringify(idsOf(onlyA))}, expected [${expenseA}]`);
    else if (!expectBoth) fail(`two-client filter returned ${JSON.stringify(idsOf(both))}`);
    else if (JSON.stringify(idsOf(unified)) !== JSON.stringify([expenseA])) fail('unified mode leaked non-expense rows into the client filter');
    else if (onlyA.totalItems !== 1 || Number(onlyA.summary.total_count) !== 1) fail(`count/summary disagree with the list: ${onlyA.totalItems}/${onlyA.summary.total_count}`);
    else if (Number(onlyA.summary.total_debit) !== Number(posted.debit)) fail(`summary debit ${onlyA.summary.total_debit} ≠ the one linked expense's posted debit ${posted.debit}`);
    else if (breakdownEntries !== 1) fail(`breakdown counted ${breakdownEntries} entries for one linked expense`);
    else console.log(`✓ expense filter: one client → 1 row (${money(posted.debit)} posted), two clients → 2 rows; count, summary and breakdown agree`);
  }

  // ── A bad direction must be rejected by the database, not just the API ──
  const { rows: anySite } = await db.query('SELECT id FROM sites ORDER BY id LIMIT 1');
  const { rows: anyMember } = await db.query(
    'SELECT id FROM members WHERE site_id = $1 LIMIT 1', [anySite[0]?.id]
  );
  if (anyMember[0]) {
    let rejected = false;
    try {
      await db.query('SAVEPOINT bad_direction');
      await db.query(
        `INSERT INTO transaction_party_links (source_key, source_id, site_id, member_id, direction)
              VALUES ('plot_payment', -1, $1, $2, 'sideways')`,
        [anySite[0].id, anyMember[0].id]
      );
    } catch { rejected = true; }
    await db.query('ROLLBACK TO SAVEPOINT bad_direction');
    if (!rejected) fail("the CHECK constraint let direction 'sideways' through");
    else console.log('✓ only credit/debit are storable as a direction');
  }
} finally {
  // Nothing this check does is meant to survive it.
  await db.query('ROLLBACK');
  db.release();
  await pool.end();
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll "Money Related To" invariants hold.');
}
