// OM ASSOCIATES — the ₹4,53,570 duplicate-commission pair.
//
// Background. Three plot-commission payouts were written to the cash book twice:
// once by the Commissions module (source_module 'plot_commission_payments') and
// once as a day-book mirror (source_module 'day_book'). Migration
// 125_daybook_internal_classification_v2 deleted the day-book copies on
// 2026-08-31, which is why the cash balance rose 32,13,392 → 36,66,962.
//
//   restore()  puts the duplicate copies back  → balance returns to 32,13,392
//   revert()   removes them again              → balance returns to 36,66,962
//
// Only cash_flow_entries rows move. day_book 223/224/231 are left alone on
// purpose: ledger_entries suppresses a day-book mirror while
// day_book.cash_flow_entry_id points at it, so re-linking them would silently
// cancel the restore (measured: insert alone 32,13,392, insert + relink
// 36,66,962). Their links were already NULL before the migration.
//
// Everything is pinned to site 5 and to these three row ids. Nothing else on
// this site, and no other site, can be touched by either direction.
//
// Safety notes
//  · Both run inside one transaction and roll back unless --yes is passed.
//  · Both are idempotent — running twice changes nothing the second time.
//  · The AFTER INSERT/DELETE trigger on cash_flow_entries routes these rows to
//    reconcile_direct_cashflow_imprest, which early-returns for a non-null
//    source_module ("DERIVED CASH-FLOW MIRROR", amount 0). No imprest float moves.
//  · The BEFORE DELETE trigger re-archives on revert; we drop that duplicate
//    archive so repeated restore/revert cycles do not pile up recycle-bin rows.
import 'dotenv/config';
import pkg from 'pg';

const { Pool } = pkg;

export const SITE_ID = 5;
export const SITE_NAME = 'OM ASSOCIATES';
export const BATCH = '1459581';
export const CFE_IDS = [3801, 3891, 5056];       // the duplicate cash_flow_entries
export const DAYBOOK_IDS = [223, 224, 231];      // their day_book parents
export const EXPECTED_TOTAL = 453570;            // ₹ of cash debit these three carry

const pool = () => new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
  ssl: (process.env.DB_SSL === 'true' || (process.env.DB_HOST || '').includes('neon'))
    ? { rejectUnauthorized: false }
    : false,
  max: 2,
});

const money = (v) => {
  const n = Number(v || 0);
  return `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
};

/** The same figure the dashboard's Cash Balance card reads. */
const cashBalance = async (db) => {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(credit - debit) FILTER (WHERE bucket = 'cash'), 0) AS cash
       FROM ledger_entries
      WHERE site_id = $1
        AND entry_date < ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)`,
    [SITE_ID],
  );
  return Number(rows[0].cash);
};

/** Refuse to run against a database where site 5 is not OM ASSOCIATES. */
const assertSite = async (db) => {
  const { rows } = await db.query('SELECT name FROM sites WHERE id = $1', [SITE_ID]);
  const name = rows[0]?.name;
  if (name !== SITE_NAME) {
    throw new Error(`Refusing to run: site ${SITE_ID} is "${name || 'missing'}", expected "${SITE_NAME}".`);
  }
};

const presentRows = async (db) => {
  const { rows } = await db.query(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, particular, debit, cash_type, source_module, source_id
       FROM cash_flow_entries
      WHERE site_id = $1 AND id = ANY($2::int[])
      ORDER BY id`,
    [SITE_ID, CFE_IDS],
  );
  return rows;
};

async function run(action, { commit }) {
  const db = pool();
  const client = await db.connect();
  let ok = false;
  try {
    await client.query('BEGIN');
    await assertSite(client);

    const before = await cashBalance(client);
    const had = await presentRows(client);
    console.log(`\nSite ${SITE_ID} · ${SITE_NAME}`);
    console.log(`Cash balance before : ${money(before)}`);
    console.log(`Duplicate rows present before: ${had.length} of ${CFE_IDS.length}`);

    const summary = await action(client);

    const after = await cashBalance(client);
    const delta = after - before;
    console.log(summary);
    console.log(`Cash balance after  : ${money(after)}  (${delta > 0 ? '+' : ''}${money(delta)})`);

    if (delta !== 0 && Math.abs(Math.abs(delta) - EXPECTED_TOTAL) > 0.005) {
      throw new Error(`Unexpected change of ${money(delta)} — expected ${money(EXPECTED_TOTAL)} or nothing. Rolling back.`);
    }

    if (commit) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED.\n');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back. Re-run with --yes to apply.\n');
    }
    ok = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\nFAILED — rolled back: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
  return ok;
}

/** Put the three duplicate cash-book rows back. Cash balance goes DOWN by ₹4,53,570. */
export const restore = (opts) => run(async (client) => {
  const { rows: inserted } = await client.query(
    `INSERT INTO cash_flow_entries
     SELECT (jsonb_populate_record(NULL::cash_flow_entries, rb.row_data)).*
       FROM recycle_bin_entries rb
      WHERE rb.deletion_batch = $1
        AND rb.site_id = $2
        AND rb.source_table = 'cash_flow_entries'
        AND rb.record_id = ANY($3::text[])
     ON CONFLICT (id) DO NOTHING
     RETURNING id, debit`,
    [BATCH, SITE_ID, CFE_IDS.map(String)],
  );

  await client.query(
    `UPDATE recycle_bin_entries
        SET restored_at = now()
      WHERE deletion_batch = $1 AND site_id = $2 AND record_id = ANY($3::text[])
        AND restored_at IS NULL`,
    [BATCH, SITE_ID, CFE_IDS.map(String)],
  );

  return `Re-inserted ${inserted.length} cash-book row(s).`;
}, opts);

/** Remove them again. Cash balance goes UP by ₹4,53,570, back to the current figure. */
export const revert = (opts) => run(async (client) => {
  // The BEFORE DELETE trigger archives whatever we remove; note the high-water
  // mark so that duplicate archive can be dropped again below.
  const { rows: [{ mark }] } = await client.query(
    'SELECT COALESCE(MAX(id), 0) AS mark FROM recycle_bin_entries',
  );

  const { rowCount: removed } = await client.query(
    `DELETE FROM cash_flow_entries
      WHERE id = ANY($1::int[])
        AND site_id = $2
        AND source_module = 'day_book'
        AND source_id = ANY($3::int[])`,
    [CFE_IDS, SITE_ID, DAYBOOK_IDS],
  );

  // Drop the re-archive so the original batch stays the single record of this.
  await client.query(
    `DELETE FROM recycle_bin_entries
      WHERE id > $1 AND source_table = 'cash_flow_entries'
        AND site_id = $2 AND record_id = ANY($3::text[])`,
    [mark, SITE_ID, CFE_IDS.map(String)],
  );

  await client.query(
    `UPDATE recycle_bin_entries
        SET restored_at = NULL
      WHERE deletion_batch = $1 AND site_id = $2 AND record_id = ANY($3::text[])`,
    [BATCH, SITE_ID, CFE_IDS.map(String)],
  );

  return `Removed ${removed} cash-book row(s).`;
}, opts);

export const commitRequested = () => process.argv.includes('--yes');
