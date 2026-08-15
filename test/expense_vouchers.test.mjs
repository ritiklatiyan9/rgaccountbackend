/**
 * Multi-file expenses: *_urls is the list, *_url mirrors the first so
 * single-file readers keep working. Run: node test/expense_vouchers.test.mjs
 */
import assert from 'node:assert/strict';
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

// Mirror of fileColumns() in expense.controller.js
const fileColumns = (listKey, urlKey, list, single) => {
  const urls = (Array.isArray(list) ? list : [single])
    .filter((u) => typeof u === 'string' && u.trim())
    .map((u) => u.trim());
  return { [listKey]: urls, [urlKey]: urls[0] || null };
};
const voucherColumns = (l, u) => fileColumns('voucher_urls', 'voucher_url', l, u);
const billColumns = (l, u) => fileColumns('bill_urls', 'bill_url', l, u);

// Bills follow the same rule as vouchers
assert.deepEqual(
  billColumns(['b1.pdf', 'b2.jpg']),
  { bill_urls: ['b1.pdf', 'b2.jpg'], bill_url: 'b1.pdf' },
);
// Removing the last bill must clear bill_url too, or the missing-bill filter
// and the approvals check would keep treating the expense as billed.
assert.deepEqual(billColumns([]), { bill_urls: [], bill_url: null });

// Many vouchers → all kept, first mirrored
assert.deepEqual(
  voucherColumns(['a.jpg', 'b.pdf', 'c.png']),
  { voucher_urls: ['a.jpg', 'b.pdf', 'c.png'], voucher_url: 'a.jpg' },
);
// Single-voucher writer (Quick Entry) → list still filled, never desynced
assert.deepEqual(voucherColumns(undefined, 'solo.jpg'), { voucher_urls: ['solo.jpg'], voucher_url: 'solo.jpg' });
// Everything removed → both cleared
assert.deepEqual(voucherColumns([]), { voucher_urls: [], voucher_url: null });
assert.deepEqual(voucherColumns(undefined, ''), { voucher_urls: [], voucher_url: null });
// Blank/whitespace entries dropped, not stored as empty vouchers
assert.deepEqual(voucherColumns(['  ', 'ok.jpg', null]), { voucher_urls: ['ok.jpg'], voucher_url: 'ok.jpg' });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: String(process.env.DB_PASSWORD || ''),
  ssl: process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
    ? { rejectUnauthorized: false }
    : false,
});

// The 6-branch UNION must agree on the new column's type, and every branch must
// return an array (never NULL) so readers can map over it unconditionally.
const { rows } = await pool.query(`
  SELECT voucher_urls, voucher_url, source
    FROM (
      SELECT voucher_url,
             COALESCE(voucher_urls, ARRAY_REMOVE(ARRAY[voucher_url], NULL)) as voucher_urls,
             'expenses' as source
        FROM expenses WHERE site_id IS NOT NULL
      UNION ALL
      SELECT fp.voucher_url, ARRAY_REMOVE(ARRAY[fp.voucher_url], NULL), 'farmer_payment'
        FROM farmer_payments fp
    ) t
   LIMIT 200
`);
assert.ok(rows.length > 0, 'expected rows to sanity-check against');
for (const r of rows) {
  assert.ok(Array.isArray(r.voucher_urls), `voucher_urls must be an array, got ${r.voucher_urls}`);
  assert.equal(r.voucher_urls[0] ?? null, r.voucher_url ?? null, 'first voucher must match voucher_url');
}

// The backfills must have left no expense row where a pair disagrees.
for (const [list, single] of [['voucher_urls', 'voucher_url'], ['bill_urls', 'bill_url']]) {
  const { rows: [drift] } = await pool.query(`
    SELECT COUNT(*)::int as n FROM expenses
     WHERE ${single} IS NOT NULL AND ${single} <> ''
       AND (${list} IS NULL OR ${list}[1] IS DISTINCT FROM ${single})
  `);
  assert.equal(drift.n, 0, `${drift.n} expenses have ${single} out of sync with ${list}`);
}

await pool.end();
console.log(`PASS: voucher+bill columns, ${rows.length} rows checked, no drift`);
