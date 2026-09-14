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
