import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import { pendingPlotPayments, createPercentagePaymentPlan } from '../src/controllers/pendingPlotPayments.controller.js';
import { addBookingMonths, buildPercentagePlan, buildPendingPaymentReport, validatePendingFilters } from '../src/services/pendingPlotPayments.service.js';

const plot = { id: 1, plot_no: 'A2', buyer_name: 'Customer A', booking_by: 'Broker A', booking_date: '2026-06-07', sale_price: '1000000', status: 'BOOKED' };
const schedule = buildPercentagePlan({ bookingDate: plot.booking_date, salePrice: plot.sale_price,
  milestones: [{ months: 3, percent: 50 }, { months: 6, percent: 100 }],
}).map((row, index) => ({ ...row, id: index + 1, plot_id: 1 }));
const report = (overrides = {}) => buildPendingPaymentReport({
  plots: [plot], installments: schedule, receipts: [{ plot_id: 1, amount: 200000 }],
  today: '2026-09-07', dateFrom: '2026-09-08', dateTo: '2026-12-07', asOf: '2026-12-07', ...overrides,
});

test('50% at three months becomes due on the exact anniversary and overdue the following day', () => {
  assert.equal(report({ today: '2026-09-06' }).summary.pending_today, 0);
  const due = report();
  assert.equal(due.summary.pending_today, 300000);
  assert.equal(due.rows[0].required_percent, 50);
  assert.equal(due.rows[0].payment_status, 'due_today');
  assert.equal(report({ today: '2026-09-08' }).rows[0].payment_status, 'overdue');
});

test('future period amounts are incremental; due-by includes arrears exactly once', () => {
  const result = report();
  assert.equal(result.summary.expected_in_period, 500000);
  assert.equal(result.summary.upcoming_in_period, 500000);
  assert.equal(result.summary.due_by_date, 800000);
  assert.deepEqual(result.rows.map((row) => row.required_percent), [50, 100]);
  assert.equal(report({ dateFrom: '2026-09-07', dateTo: '2026-12-07' }).summary.expected_in_period, 800000);
  assert.equal(report({ dateFrom: '2026-09-08', dateTo: '2026-12-06' }).summary.expected_in_period, 0);
});

test('advance receipts, fully paid plots and refunds update the projection without stored statuses', () => {
  const advance = report({ receipts: [{ plot_id: 1, amount: 700000 }] });
  assert.equal(advance.summary.pending_today, 0);
  assert.equal(advance.summary.expected_in_period, 300000);
  assert.equal(report({ receipts: [{ plot_id: 1, amount: 1100000 }] }).rows.length, 0);
  const refunded = report({ receipts: [{ plot_id: 1, amount: 700000 }, { plot_id: 1, amount: -300000 }] });
  assert.equal(refunded.summary.pending_today, 100000);
});

test('legacy direct payments remain assigned and are not counted twice with plot receipts', () => {
  const result = report({ receipts: [{ plot_id: 1, amount: 200000 }, { plot_id: 1, installment_id: 2, amount: 100000 }] });
  assert.equal(result.rows[0].payment_received, 300000);
  assert.equal(result.summary.pending_today, 300000);
  assert.equal(result.summary.expected_in_period, 400000);
  assert.equal(result.summary.due_by_date, 700000);
});

test('broker filters apply to every metric and preserve broker options; closed bookings are excluded', () => {
  const other = { ...plot, id: 2, booking_by: 'Broker B' };
  const input = { plots: [plot, other, { ...plot, id: 3, plot_tag: 'OLD' }, { ...plot, id: 4, status: 'CANCELLED' }],
    installments: [1, 2, 3, 4].flatMap((plotId) => schedule.map((row) => ({ ...row, id: plotId * 10 + row.id, plot_id: plotId }))), receipts: [],
  };
  assert.equal(report(input).summary.pending_today, 1000000);
  const filtered = report({ ...input, broker: 'Broker B' });
  assert.equal(filtered.summary.pending_today, 500000);
  assert.equal(filtered.summary.pending_plot_count, 1);
  assert.deepEqual(filtered.brokers, ['Broker A', 'Broker B']);
  assert.ok(filtered.rows.every((row) => row.plot_id === 2));
  assert.equal(report({ ...input, broker: '__unassigned__' }).rows.length, 0);
});

test('missing and partial schedules expose unscheduled balances without inventing due dates', () => {
  const missing = report({ installments: [] });
  assert.equal(missing.rows.length, 0);
  assert.equal(missing.summary.pending_today, 0);
  assert.equal(missing.needs_plan[0].unscheduled_amount, 800000);
  assert.equal(missing.needs_plan[0].has_schedule, false);
  const partial = report({ installments: [schedule[0]] });
  assert.equal(partial.summary.pending_today, 300000);
  assert.equal(partial.needs_plan[0].unscheduled_amount, 500000);
  assert.equal(partial.needs_plan[0].has_schedule, true);
});

test('calendar months clamp month ends, respect leap years and cross years', () => {
  assert.equal(addBookingMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addBookingMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addBookingMonths('2026-11-30', 3), '2027-02-28');
  const plan = buildPercentagePlan({ bookingDate: '2026-01-31', salePrice: 100.01, milestones: [
    { months: 0, percent: 33.33 }, { months: 1, percent: 66.66 }, { months: 2, percent: 100 },
  ] });
  assert.equal(Math.round(plan.reduce((sum, row) => sum + row.amount, 0) * 100), 10001);
  assert.equal(plan[1].due_date, '2026-02-28');
});

test('invalid dates and ambiguous cumulative schedules are rejected before writing', () => {
  for (const milestones of [[], [null], [{ months: -1, percent: 50 }], [{ months: '', percent: 50 }], [{ months: 3, percent: 101 }],
    [{ months: 3, percent: 50 }, { months: 6, percent: 40 }], [{ months: 3, percent: 50 }, { months: 3, percent: 100 }]]) {
    assert.throws(() => buildPercentagePlan({ bookingDate: plot.booking_date, salePrice: plot.sale_price, milestones }));
  }
  for (const dateFrom of ['2026-02-30', '2026-09-10', 'garbage']) {
    assert.throws(() => validatePendingFilters({ dateFrom, dateTo: '2026-09-07', asOf: '2026-09-07', today: '2026-09-07' }));
  }
  assert.throws(() => report({ asOf: '2026-09-06' }), { statusCode: 400 });
});

const invoke = (handler, req) => new Promise((resolve, reject) => {
  let status = 200;
  handler(req, { status(code) { status = code; return this; }, json(data) { resolve({ status, data }); } }, reject);
});

test('read API scopes receipts to the site, posting rules, today and creator visibility', async (t) => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM plots WHERE')) return { rows: [plot] };
    if (sql.includes('FROM plot_installments WHERE')) return { rows: schedule };
    return { rows: [{ plot_id: 1, amount: 200000 }] };
  });
  const response = await invoke(pendingPlotPayments, { query: { site_id: '9', created_by: '999' },
    user: { id: 7, role: 'sub_admin', permissionsByModule: new Map([['plot_payments', { can_view_all: false }]]) },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].params, [9]);
  const receipts = calls.find((call) => call.sql.includes('UNION ALL'));
  assert.equal(receipts.params[1], 7);
  assert.match(receipts.sql, /date BETWEEN DATE '1900-01-01' AND \$3::date/);
  assert.match(receipts.sql, /payment_date BETWEEN DATE '1900-01-01' AND \$3::date/);
  assert.equal((receipts.sql.match(/financial_transaction_posts/g) || []).length, 2);
  assert.equal(response.data.receipt_scope, 'creator');
  assert.ok(calls.every(({ sql }) => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql)));
});

test('plan creation atomically saves incremental installments; existing plans are preserved', async (t) => {
  const calls = [];
  let exists = false;
  t.mock.method(pool, 'connect', async () => ({ release() {}, async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM plots WHERE')) return { rows: [plot] };
    if (sql.includes('SELECT id FROM plot_installments')) return { rows: exists ? [{ id: 1 }] : [] };
    return { rows: [] };
  } }));
  const req = { params: { id: '1' }, body: { milestones: [{ months: 3, percent: 50 }, { months: 6, percent: 100 }] } };
  assert.equal((await invoke(createPercentagePaymentPlan, req)).status, 201);
  assert.deepEqual(calls.find(({ sql }) => sql.includes('INSERT INTO plot_installments')).params[2], [500000, 500000]);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  exists = true; calls.length = 0;
  assert.equal((await invoke(createPercentagePaymentPlan, req)).status, 409);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.ok(calls.every(({ sql }) => !sql.includes('INSERT INTO')));
});
