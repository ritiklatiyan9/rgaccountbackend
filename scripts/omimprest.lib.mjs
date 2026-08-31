// OM ASSOCIATES — wipe the imprest module clean and start again from the
// Site Balance.
//
// End state after reset():
//   Kuldeep Tomar's admin float   8,15,067 → 0
//   RAVI SIVACH's float           0        → 0
//   Held by staff                 0
//   Site Balance                  34,94,465.62   (unchanged)
//   Available to distribute       26,79,398.62 → 34,94,465.62
//
// Cash and bank are NOT touched. imprest_ledger never feeds ledger_entries —
// the float only ever subtracts from what is distributable, so clearing it
// returns the full Site Balance to "available" and moves no money. The script
// aborts if cash or bank shifts by even a paisa.
//
// Everything is pinned to site 5. Rows are archived to the recycle bin under a
// single batch tag first, so the revert script can put the history back.
import 'dotenv/config';
import pkg from 'pg';

const { Pool } = pkg;

export const SITE_ID = 5;
export const SITE_NAME = 'OM ASSOCIATES';
// deletion_batch is a bigint, so the tag is a sentinel number well clear of the
// app's own batch counter (~1.4M) — 9e9 + the site id.
export const BATCH = 9000000005;
// Children before parents on delete; reversed on restore.
export const TABLES = [
  'imprest_debit_reservations',
  'imprest_expense_requests',
  'imprest_returns',
  'imprest_allocations',
  'imprest_ledger',
];

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
  return `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Everything /imprest-management puts on screen, straight from the same SQL. */
const snapshot = async (db) => {
  const { rows } = await db.query(
    `WITH l AS (
       SELECT COALESCE(SUM(credit - debit) FILTER (WHERE bucket = 'cash'), 0) cash,
              COALESCE(SUM(credit - debit) FILTER (WHERE bucket <> 'cash'), 0) bank
         FROM ledger_entries
        WHERE site_id = $1 AND entry_date < ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1)
     ), ui AS (
       SELECT LOWER(COALESCE(u.role, '')) role, COALESCE(SUM(il.amount), 0) bal
         FROM imprest_ledger il JOIN users u ON u.id = il.user_id
        WHERE il.site_id = $1
        GROUP BY il.user_id, LOWER(COALESCE(u.role, ''))
     ), i AS (
       SELECT COALESCE(SUM(GREATEST(bal, 0)) FILTER (WHERE role NOT IN ('admin','super_admin')), 0) held,
              COALESCE(SUM(GREATEST(bal, 0)) FILTER (WHERE role IN ('admin','super_admin')), 0) admin_float
         FROM ui
     ), p AS (
       SELECT COALESCE(SUM(amount), 0) pend FROM imprest_allocations
        WHERE site_id = $1 AND status = 'PENDING_RECEIPT' AND from_own_float = false
     )
     SELECT l.cash, l.bank, i.held, i.admin_float, p.pend,
            l.cash + l.bank - i.held                              AS site_balance,
            l.cash + l.bank - i.held - i.admin_float - p.pend     AS available
       FROM l, i, p`,
    [SITE_ID],
  );
  const r = rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
};

const show = (label, s) => {
  console.log(`\n${label}`);
  console.log(`  Cash                    ${money(s.cash)}`);
  console.log(`  Bank                    ${money(s.bank)}`);
  console.log(`  Held by staff           ${money(s.held)}`);
  console.log(`  Admin float             ${money(s.admin_float)}`);
  console.log(`  Awaiting receipt        ${money(s.pend)}`);
  console.log(`  Site Balance            ${money(s.site_balance)}`);
  console.log(`  Available to distribute ${money(s.available)}`);
};

const assertSite = async (db) => {
  const { rows } = await db.query('SELECT name FROM sites WHERE id = $1', [SITE_ID]);
  if (rows[0]?.name !== SITE_NAME) {
    throw new Error(`Refusing: site ${SITE_ID} is "${rows[0]?.name || 'missing'}", expected "${SITE_NAME}".`);
  }
};

async function run(action, { commit }) {
  const db = pool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertSite(client);

    const before = await snapshot(client);
    show(`Site ${SITE_ID} · ${SITE_NAME} — BEFORE`, before);

    const notes = await action(client, before);

    const after = await snapshot(client);
    show('AFTER', after);
    notes.forEach((n) => console.log(`  · ${n}`));

    // The one invariant that must never break: this touches floats, not money.
    if (Math.abs(after.cash - before.cash) > 0.005 || Math.abs(after.bank - before.bank) > 0.005) {
      throw new Error('Cash or bank moved — this script must never do that. Rolling back.');
    }

    if (commit) {
      await client.query('COMMIT');
      console.log('\nCOMMITTED.\n');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDRY RUN — rolled back. Re-run with --yes to apply.\n');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\nFAILED — rolled back: ${err.message}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await db.end();
  }
}

/** Clear every imprest record on this site; floats go to zero. */
export const reset = (opts) => run(async (client) => {
  const notes = [];

  // imprest_ledger has no recycle-bin trigger, so archive it by hand.
  const { rowCount: archived } = await client.query(
    `INSERT INTO recycle_bin_entries
       (organization_id, site_id, deletion_batch, source_schema, source_table, source_module,
        source_primary_key, record_id, display_name, delete_kind, row_data, deleted_at)
     SELECT 1, $1, $2, 'public', 'imprest_ledger', 'imprest',
            jsonb_build_object('id', il.id), il.id::text,
            COALESCE(il.remarks, 'Imprest Ledger #' || il.id), 'HARD', to_jsonb(il), now()
       FROM imprest_ledger il WHERE il.site_id = $1`,
    [SITE_ID, BATCH],
  );
  notes.push(`archived ${archived} imprest_ledger row(s)`);

  // Anything the delete triggers archive lands above this id.
  const { rows: [{ mark }] } = await client.query(
    'SELECT COALESCE(MAX(id), 0) AS mark FROM recycle_bin_entries',
  );

  for (const table of TABLES) {
    const { rowCount } = await client.query(`DELETE FROM ${table} WHERE site_id = $1`, [SITE_ID]);
    if (rowCount) notes.push(`deleted ${rowCount} row(s) from ${table}`);
  }

  // Fold the trigger-written archives into the same batch so revert is one unit.
  await client.query(
    `UPDATE recycle_bin_entries SET deletion_batch = $1
      WHERE id > $2 AND site_id = $3 AND source_table = ANY($4::text[])`,
    [BATCH, mark, SITE_ID, TABLES],
  );

  return notes;
}, opts);

/** Put the archived imprest history back exactly as it was. */
export const restore = (opts) => run(async (client) => {
  const notes = [];
  for (const table of [...TABLES].reverse()) {
    const { rowCount } = await client.query(
      `INSERT INTO ${table}
       SELECT (jsonb_populate_record(NULL::${table}, rb.row_data)).*
         FROM recycle_bin_entries rb
        WHERE rb.deletion_batch = $1 AND rb.site_id = $2 AND rb.source_table = $3
          AND rb.restored_at IS NULL
       ON CONFLICT DO NOTHING`,
      [BATCH, SITE_ID, table],
    );
    if (rowCount) notes.push(`restored ${rowCount} row(s) into ${table}`);
  }
  await client.query(
    `UPDATE recycle_bin_entries SET restored_at = now()
      WHERE deletion_batch = $1 AND site_id = $2 AND restored_at IS NULL`,
    [BATCH, SITE_ID],
  );
  if (!notes.length) notes.push('nothing archived under this batch — already restored, or reset never ran');
  return notes;
}, opts);

export const commitRequested = () => process.argv.includes('--yes');
