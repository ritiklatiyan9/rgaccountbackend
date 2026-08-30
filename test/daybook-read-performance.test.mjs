import assert from 'node:assert/strict';
import test from 'node:test';

import { dayBookDailyBalanceModel } from '../src/models/DayBookDailyBalance.model.js';
import {
  loadDayBookAuxiliaryData,
  loadDayBookModeBalanceData,
  loadSiteBalanceAsOf,
} from '../src/services/daybookRead.service.js';

const fakeQueryable = (rows) => {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
};

test('Day Book auxiliary metadata uses one database round trip', async () => {
  const db = fakeQueryable([{
    saved_order_rows: [{ entry_key: 'expenses:12', position: 1 }],
    order_revision: '7',
    site_row: { name: 'Site', city: 'City', state: 'State' },
    daily_balance_row: { opening_balance: 900, closing_balance: 1100 },
    bank_map_rows: [{ id: 4, source_module: 'expenses', source_id: 12 }],
  }]);

  const result = await loadDayBookAuxiliaryData(8, '2026-08-30', db, 21);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [8, '2026-08-30', 21]);
  assert.match(db.calls[0].sql, /daybook_entry_order/);
  assert.match(db.calls[0].sql, /daybook_order_state/);
  assert.match(db.calls[0].sql, /day_book_daily_balance/);
  assert.match(db.calls[0].sql, /bank_accounts/);
  assert.match(db.calls[0].sql, /cfe\.created_by = \$3/);
  assert.equal(result.orderRevision, 7);
  assert.equal(result.savedOrderRows.length, 1);
  assert.deepEqual(result.dailyBalanceRow, { opening_balance: 900, closing_balance: 1100 });
  assert.equal(result.bankMapRows.length, 1);
});

test('site balance combines ledger and imprest into one query', async () => {
  const db = fakeQueryable([{ ledger_net: '1250.50', imprest_outstanding: '200.25' }]);

  const result = await loadSiteBalanceAsOf('8', '2026-08-30', db);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [8, '2026-08-30']);
  assert.match(db.calls[0].sql, /FROM ledger_entries le/);
  assert.match(db.calls[0].sql, /FROM imprest_ledger il/);
  assert.equal(result, 1050.25);
});

test('unrestricted mode balance scans the normalized site ledger once', async () => {
  const db = fakeQueryable([
    {
      row_kind: 'bucket', bucket: 'cash', is_before: true, src: 'expenses',
      credit: '50', debit: '20', site_opening: null, site_current: null,
      imprest_float: null,
    },
    {
      row_kind: 'summary', bucket: null, is_before: null, src: null,
      credit: null, debit: null, site_opening: '900', site_current: '1200',
      imprest_float: '75',
    },
  ]);

  const result = await loadDayBookModeBalanceData({
    siteId: 8,
    date: '2026-08-30',
  }, db);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [8, '2026-08-30', '2100-01-01']);
  assert.equal((db.calls[0].sql.match(/FROM ledger_entries le/g) || []).length, 1);
  assert.equal((db.calls[0].sql.match(/FROM imprest_ledger il/g) || []).length, 1);
  assert.match(db.calls[0].sql, /WITH ledger AS MATERIALIZED/);
  assert.equal(result.rows.length, 1);
  assert.equal(result.siteOpening, 900);
  assert.equal(result.siteCurrent, 1200);
  assert.equal(result.imprestFloat, 75);
});

test('creator-scoped mode balance stays one query and skips site-wide scans', async () => {
  const db = fakeQueryable([{
    bucket: 'bank', is_before: false, src: 'plot_payments', credit: '500', debit: '0',
  }]);

  const result = await loadDayBookModeBalanceData({
    siteId: 8,
    date: '2026-08-30',
    creatorId: 21,
  }, db);

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params, [8, '2026-08-30', 21]);
  assert.match(db.calls[0].sql, /creator_cfe\.created_by = \$3/);
  assert.doesNotMatch(db.calls[0].sql, /imprest_ledger/);
  assert.equal(result.siteOpening, null);
  assert.equal(result.siteCurrent, null);
  assert.equal(result.imprestFloat, 0);
});

test('daily closing balance avoids a write when the value is unchanged', async () => {
  const db = fakeQueryable([]);

  const result = await dayBookDailyBalanceModel.updateClosing(8, '2026-08-30', 1000, db);

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /closing_balance IS DISTINCT FROM \$3::numeric/);
  assert.equal(result, null);
});
