import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import balanceSheet from '../src/models/BalanceSheet.model.js';
import { updateDayBookOrder } from '../src/controllers/daybook.controller.js';

test('period reads apply saved cross-date positions before date order and pagination', async (t) => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    return calls.length === 1 ? { rows: [{ report: { order_revision: 2 } }] } : { rows: [] };
  });
  await balanceSheet.getReport({ siteId: 9, scope: 'bank', limit: 50 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /ORDER BY global_display_position ASC NULLS LAST,\s+entry_date DESC,[\s\S]*LIMIT \$9::int/);
  assert.equal(calls[1].params[8], 50);
});

test('a partial cross-date save shifts selected entries and preserves other books', async (t) => {
  const calls = [];
  const currentKeys = ['expenses:3', 'day_book:2', 'expenses:1', 'day_book:4'];
  const client = {
    release() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO daybook_global_order_state')) {
        return { rows: [{ revision: 2, last_request_id: null }] };
      }
      if (sql.includes('SELECT ordered.entry_key')) {
        assert.match(sql, /ORDER BY ordered.global_position ASC NULLS LAST,\s+ordered.entry_date DESC/);
        return { rows: currentKeys.map(entry_key => ({ entry_key })) };
      }
      if (sql.includes('WITH deleted AS')) return { rows: [{ deleted_count: 0, revision: 3 }] };
      return { rows: [], rowCount: 4 };
    },
  };
  t.mock.method(pool, 'connect', async () => client);
  const response = await new Promise((resolve, reject) => {
    updateDayBookOrder({
      user: { id: 5 },
      body: { site_id: 9, partial: true, global_entry_keys: ['expenses:1', 'expenses:3'], expected_revision: 2, request_id: 'reorder-test-1' },
    }, { json: resolve, status(code) { reject(new Error(`Unexpected status ${code}`)); return this; } }, reject);
  });
  const write = calls.find(({ sql }) => sql.includes('INSERT INTO daybook_global_order\n'));
  assert.deepEqual(write.params[2], ['expenses:1', 'day_book:2', 'expenses:3', 'day_book:4']);
  assert.equal(response.order_revision, 3);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.ok(calls.every(({ sql }) => !/(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:ledger_entries|cash_flow_entries|expenses|day_book)\b/i.test(sql)));
});
