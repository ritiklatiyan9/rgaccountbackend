// Self-check for the expense drag order: reorder one date, confirm the list
// query returns that sequence, then restore display_order to NULL.
import assert from 'node:assert/strict';
import pool from './src/config/db.js';
import { expenseModel } from './src/models/Expense.model.js';

const day = await pool.query(`
  SELECT site_id, date, COUNT(*)::int c FROM expenses
  GROUP BY site_id, date HAVING COUNT(*) >= 3 ORDER BY c ASC LIMIT 1
`);
const { site_id: siteId, date } = day.rows[0];
const dateStr = date.toISOString().slice(0, 10);
console.log('testing site', siteId, 'date', dateStr, 'rows', day.rows[0].c);

const listed = async () => {
  const r = await expenseModel.findPaginatedUnified(
    siteId, { only_site: 'true', dateFrom: dateStr, dateTo: dateStr, order: 'desc' }, 1, 0, pool
  );
  return r.items.map((e) => Number(e.id));
};

const before = await listed();
const shuffled = [before[before.length - 1], ...before.slice(0, -1)];

const updated = await expenseModel.reorderByDate(siteId, dateStr, shuffled, pool);
assert.equal(updated, shuffled.length, 'every id should update');
assert.deepEqual(await listed(), shuffled, 'list must come back in the saved order');

// Ascending date sort must not scramble a hand-arranged day.
const asc = await expenseModel.findPaginatedUnified(
  siteId, { only_site: 'true', dateFrom: dateStr, dateTo: dateStr, order: 'asc' }, 1, 0, pool
);
assert.deepEqual(asc.items.map((e) => Number(e.id)), shuffled, 'order holds under asc sort');

// Wrong date is refused (0 rows matched, controller turns that into a 409).
assert.equal(await expenseModel.reorderByDate(siteId, '1999-01-01', shuffled, pool), 0);

await pool.query('UPDATE expenses SET display_order = NULL WHERE site_id = $1 AND date = $2::date', [siteId, dateStr]);
assert.deepEqual(await listed(), before, 'restored to the original sequence');

console.log('expense drag order: OK');
await pool.end();
