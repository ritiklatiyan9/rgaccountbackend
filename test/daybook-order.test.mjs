import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import balanceSheet from '../src/models/BalanceSheet.model.js';
import { updateDayBookOrder } from '../src/controllers/daybook.controller.js';

test('period reads keep dates first and share daily positions before legacy order and pagination', async (t) => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    return calls.length === 1 ? { rows: [{ report: { order_revision: 2 } }] } : { rows: [] };
  });
  await balanceSheet.getReport({ siteId: 9, scope: 'bank', limit: 50 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /ORDER BY entry_date DESC,\s+display_position ASC NULLS LAST,\s+global_display_position ASC NULLS LAST,[\s\S]*LIMIT \$9::int/);
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
        assert.match(sql, /ORDER BY ordered.entry_date DESC,\s+ordered.local_position ASC NULLS LAST,\s+ordered.global_position ASC NULLS LAST/);
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

const save = (body) => new Promise((resolve, reject) => {
  let status = 200;
  updateDayBookOrder({ user: { id: 5 }, body }, {
    status(code) { status = code; return this; },
    json(data) { resolve({ status, data }); },
  }, reject);
});

test('period saves reuse daily positions, preserve cash slots and carry separate date revisions', async (t) => {
  const calls = [];
  const client = {
    release() {},
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO daybook_order_state')) return { rows: [{ revision: 2 }] };
      if (sql.includes('SELECT entry_key')) return { rows: [] };
      if (sql.includes('SELECT ordered.entry_key')) return { rows: ['expenses:1', 'day_book:2', 'expenses:3'].map(entry_key => ({ entry_key })) };
      if (sql.includes('WITH deleted AS')) return { rows: [{ deleted_count: 0, revision: 3 }] };
      return { rows: [], rowCount: 3 };
    },
  };
  t.mock.method(pool, 'connect', async () => client);
  const response = await save({ site_id: 9, partial: true, orders: ['2026-09-05', '2026-08-31'].map(date => ({ date, entry_keys: ['expenses:3', 'expenses:1'], expected_revision: 2, request_id: `date-save:${date}` })) });
  assert.equal(response.status, 200);
  const writes = calls.filter(({ sql }) => sql.includes('INSERT INTO daybook_entry_order\n'));
  assert.deepEqual(writes.map(c => c.params[1]), ['2026-08-31', '2026-09-05']);
  writes.forEach(({ params }) => assert.deepEqual(params[3], ['expenses:3', 'day_book:2', 'expenses:1']));
  assert.deepEqual(response.data.order_revisions, { '2026-08-31': 3, '2026-09-05': 3 });
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.ok(calls.every(({ sql }) => !/(?:UPDATE|DELETE FROM|INSERT INTO)\s+(?:ledger_entries|cash_flow_entries|expenses|day_book)\b/i.test(sql)));
});

test('a concurrent date edit rejects a stale saved key and rolls back the reorder', async (t) => {
  const calls = [];
  t.mock.method(pool, 'connect', async () => ({
    release() {},
    async query(sql) {
      calls.push(sql);
      if (sql.includes('INSERT INTO daybook_order_state')) return { rows: [{ revision: 2 }] };
      if (sql.includes('SELECT entry_key')) return { rows: [{ entry_key: 'expenses:1' }] };
      if (sql.includes('SELECT ordered.entry_key')) return { rows: [{ entry_key: 'expenses:3' }] };
      return { rows: [] };
    },
  }));
  const response = await save({ site_id: 9, partial: true, orders: [{ date: '2026-09-05', entry_keys: ['expenses:1', 'expenses:3'], expected_revision: 2 }] });
  assert.equal(response.status, 409);
  assert.match(response.data.message, /no longer available/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(calls.every(sql => !sql.includes('INSERT INTO daybook_entry_order\n')));
});

test('retrying an already saved date leaves its positions unchanged', async (t) => {
  const calls = [];
  t.mock.method(pool, 'connect', async () => ({
    release() {},
    async query(sql) {
      calls.push(sql);
      return { rows: sql.includes('INSERT INTO daybook_order_state') ? [{ revision: 3, last_request_id: 'date-save:2026-09-05' }] : [] };
    },
  }));
  const response = await save({ site_id: 9, partial: true, orders: [{ date: '2026-09-05', entry_keys: ['expenses:1'], expected_revision: 2, request_id: 'date-save:2026-09-05' }] });
  assert.equal(response.status, 200);
  assert.equal(response.data.order_revision, 3);
  assert.equal(response.data.already_applied, true);
  assert.ok(calls.every(sql => !sql.includes('INSERT INTO daybook_entry_order\n')));
});
