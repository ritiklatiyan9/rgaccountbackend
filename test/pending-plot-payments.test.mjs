import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import { pendingPlotPayments, createPercentagePaymentPlan, setFullPaymentDue } from '../src/controllers/pendingPlotPayments.controller.js';
import { addBookingMonths, buildPercentagePlan, buildPendingPaymentReport, validatePendingFilters } from '../src/services/pendingPlotPayments.service.js';

const plot = { id: 1, plot_no: 'A2', buyer_name: 'Customer A', buyer_phone: '9876543210',
  booking_by: 'Broker A', broker_phone: '9123456780', booking_date: '2026-06-07', sale_price: '1000000', status: 'BOOKED' };
const schedule = buildPercentagePlan({ bookingDate: plot.booking_date, salePrice: plot.sale_price,
  milestones: [{ months: 0, percent: 25 }, { months: 3, percent: 50 }, { months: 6, percent: 100 }],
}).map((row, index) => ({ ...row, id: index + 1, plot_id: 1 }));
const report = (overrides = {}) => buildPendingPaymentReport({
  plots: [plot], installments: schedule, receipts: [{ plot_id: 1, amount: 200000 }],
  today: '2026-09-07', dateFrom: '2026-09-08', dateTo: '2026-12-07', asOf: '2026-12-07', ...overrides,
});

test('25% is due on booking and the next cumulative target uses that date as its anchor', () => {
  assert.equal(report({ today: '2026-06-06' }).summary.pending_today, 0);
  // Installment 2 is pending from the day after installment 1's due date.
  assert.equal(report({ today: '2026-06-07' }).summary.pending_today, 50000);
  const early = report({ today: '2026-06-08' });
  assert.equal(early.summary.pending_today, 300000);
  assert.equal(early.rows[1].payment_status, 'pending');
  const due = report();
  assert.equal(due.summary.pending_today, 300000);
  assert.deepEqual(due.rows.map((row) => row.required_percent), [25, 50, 100]);
  assert.deepEqual(due.rows.map((row) => row.pending_from), ['2026-06-07', '2026-06-08', '2026-09-08']);
  assert.equal(due.rows[1].payment_status, 'due_today');
  assert.equal(report({ today: '2026-09-08' }).rows[1].payment_status, 'overdue');
});

test('a token paid on booking day leaves installment 1 pending from that first day, before its due date', () => {
  const booked = { ...plot, booking_date: '2026-09-24', sale_price: '1306000' };
  const result = buildPendingPaymentReport({ plots: [booked],
    installments: [
      { id: 1, plot_id: 1, amount: 653000, due_date: '2026-10-24', sort_order: 1 },
      { id: 2, plot_id: 1, amount: 653000, due_date: '2026-11-24', sort_order: 2 },
    ],
    receipts: [{ plot_id: 1, amount: 10000, receipt_date: '2026-09-24' }],
    today: '2026-10-13', dateFrom: '2026-10-14', dateTo: '2026-11-12', asOf: '2026-11-12' });
  assert.deepEqual(result.rows.map((row) => [row.pending_from, row.payment_status]),
    [['2026-09-24', 'pending'], ['2026-10-25', 'upcoming']]);
  assert.equal(result.summary.pending_today, 643000);
  assert.equal(result.summary.upcoming_in_period, 653000);
  assert.equal(result.summary.expected_in_period, 643000);
  assert.equal(result.summary.due_by_date, 1296000);
});

test('future period amounts are incremental; due-by includes arrears exactly once', () => {
  const result = report();
  assert.equal(result.summary.expected_in_period, 500000);
  assert.equal(result.summary.upcoming_in_period, 500000);
  assert.equal(result.summary.due_by_date, 800000);
  assert.deepEqual(result.rows.map((row) => row.required_percent), [25, 50, 100]);
  assert.equal(report({ dateFrom: '2026-09-07', dateTo: '2026-12-07' }).summary.expected_in_period, 750000);
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

test('installment details retain paid milestones and plot status without adding them to collection totals', () => {
  const result = report({ plots: [{ ...plot, approval_status: 'pending' }], receipts: [{ plot_id: 1, amount: 300000 }] });
  assert.equal(result.rows.length, 2);
  assert.equal(result.installments.length, 3);
  assert.equal(result.installments[0].payment_status, 'paid');
  assert.equal(result.installments[0].pending_amount, 0);
  assert.equal(result.installments[0].installment_received, 250000);
  assert.equal(result.installments[2].payment_status, 'upcoming');
  assert.ok(result.installments.every((row) => row.status === 'BOOKED' && row.approval_status === 'pending'));
  assert.equal(result.summary.due_by_date, 700000);
});

test('paid dates follow dated plot receipts through complete and partial installment targets', () => {
  const result = report({ receipts: [
    { plot_id: 1, amount: 200000, receipt_date: '2026-06-10' },
    { plot_id: 1, amount: 100000, receipt_date: '2026-07-10' },
    { plot_id: 1, amount: 250000, receipt_date: '2026-08-10' },
  ] });
  assert.deepEqual(result.installments.map((row) => row.paid_date), ['2026-07-10', '2026-08-10', '2026-08-10']);
  assert.deepEqual(result.installments.map((row) => row.installment_received), [250000, 250000, 50000]);
  assert.equal(result.summary.due_by_date, 450000);
  assert.ok(report().installments.every((row) => row.paid_date === null));
});

test('linked payments keep their dates and refunds never become installment paid dates', () => {
  const receipts = [
    { plot_id: 1, amount: 350000, receipt_date: '2026-07-01' },
    { plot_id: 1, installment_id: 2, amount: 100000, receipt_date: '2026-08-01' },
  ];
  const result = report({ receipts });
  assert.deepEqual(result.installments.map((row) => row.paid_date), ['2026-07-01', '2026-08-01', null]);
  const reversed = report({ receipts: [...receipts,
    { plot_id: 1, installment_id: 2, amount: -100000, receipt_date: '2026-09-01' },
  ] });
  assert.deepEqual(reversed.installments.map((row) => row.paid_date), ['2026-07-01', '2026-07-01', null]);
  const refunded = report({ receipts: [
    { plot_id: 1, amount: 200000, receipt_date: '2026-06-10' },
    { plot_id: 1, amount: 100000, receipt_date: '2026-07-10' },
    { plot_id: 1, amount: -100000, receipt_date: '2026-08-10' },
  ] });
  assert.deepEqual(refunded.installments.map((row) => row.paid_date), ['2026-06-10', null, null]);
  const fullyReversed = report({ receipts: [
    { plot_id: 1, amount: 300000, receipt_date: '2026-06-10' },
    { plot_id: 1, amount: -300000, receipt_date: '2026-07-10' },
  ] });
  assert.ok(fullyReversed.installments.every((row) => row.paid_date === null));
});

test('later overpayments do not overwrite installment paid dates and full-payment rows use posted receipts', () => {
  const result = report({ receipts: [
    { plot_id: 1, amount: 600000, receipt_date: '2026-06-10' },
    { plot_id: 1, amount: 500000, receipt_date: '2026-07-10' },
    { plot_id: 1, amount: 100000, receipt_date: '2026-08-10' },
  ] });
  assert.deepEqual(result.installments.map((row) => row.paid_date), ['2026-06-10', '2026-06-10', '2026-07-10']);
  const full = report({ plots: [{ ...plot, full_payment_due: true }], receipts: [
    { plot_id: 1, amount: 200000, receipt_date: '2026-06-10' },
    { plot_id: 1, installment_id: 2, amount: 100000, receipt_date: '2026-07-10' },
  ] });
  assert.equal(full.rows[0].paid_date, '2026-07-10');
  assert.equal(full.rows[0].pending_amount, 700000);
});

test('Company plots with an explicit payment schedule are included while bare company inventory is excluded', () => {
  const company = { ...plot, status: 'COMPANY' };
  const result = report({ plots: [company, { ...company, id: 2 }], receipts: [] });
  assert.equal(result.summary.pending_today, 500000);
  assert.ok(result.rows.every((row) => row.status === 'COMPANY' && row.plot_id === 1));
  assert.equal(result.needs_plan.length, 0);
  assert.equal(report({ plots: [company], installments: [] }).needs_plan.length, 0);
});

test('legacy direct payments remain assigned and are not counted twice with plot receipts', () => {
  const result = report({ receipts: [{ plot_id: 1, amount: 200000 }, { plot_id: 1, installment_id: 2, amount: 100000 }] });
  assert.equal(result.rows[0].payment_received, 300000);
  assert.equal(result.summary.pending_today, 200000);
  assert.equal(result.summary.expected_in_period, 500000);
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
  assert.equal(missing.needs_plan[0].buyer_phone, '9876543210');
  assert.equal(missing.needs_plan[0].broker_phone, '9123456780');
  const partial = report({ installments: [schedule[0]] });
  assert.equal(partial.summary.pending_today, 50000);
  assert.equal(partial.needs_plan[0].unscheduled_amount, 750000);
  assert.equal(partial.needs_plan[0].has_schedule, true);
});

test('full payment makes the entire remaining balance due once until receipts settle it', () => {
  const fullPlot = { ...plot, full_payment_due: true, full_payment_due_date: '2026-09-07' };
  const due = report({ plots: [fullPlot] });
  assert.equal(due.rows.length, 1);
  assert.equal(due.rows[0].installment_name, 'Full payment');
  assert.equal(due.rows[0].required_percent, 100);
  assert.equal(due.rows[0].pending_amount, 800000);
  assert.equal(due.summary.pending_today, 800000);
  assert.equal(due.needs_plan.length, 0);
  assert.equal(report({ plots: [fullPlot], installments: [] }).summary.pending_today, 800000);
  assert.equal(report({ plots: [fullPlot], receipts: [{ plot_id: 1, amount: 1000000 }] }).rows.length, 0);
  assert.equal(report({ plots: [fullPlot], receipts: [{ plot_id: 1, amount: 1000000 }, { plot_id: 1, amount: -100000 }] }).summary.pending_today, 100000);
  assert.equal(report({ plots: [fullPlot], today: '2026-09-08' }).rows[0].payment_status, 'overdue');
  assert.equal(report().rows.length, 3);
});

test('calendar months clamp month ends, respect leap years and cross years', () => {
  assert.equal(addBookingMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addBookingMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addBookingMonths('2026-11-30', 3), '2027-02-28');
  const plan = buildPercentagePlan({ bookingDate: '2026-01-31', salePrice: 100.01, milestones: [
    { months: 0, percent: 25 }, { months: 1, percent: 66.66 }, { months: 2, percent: 100 },
  ] });
  assert.equal(Math.round(plan.reduce((sum, row) => sum + row.amount, 0) * 100), 10001);
  assert.equal(plan[1].due_date, '2026-02-28');
});

test('invalid dates and ambiguous cumulative schedules are rejected before writing', () => {
  for (const milestones of [[], [null], [{ months: -1, percent: 50 }], [{ months: '', percent: 50 }], [{ months: 3, percent: 101 }],
    [{ months: 0, percent: 20 }, { months: 3, percent: 100 }],
    [{ months: 0, percent: 25 }, { months: 6, percent: 40 }, { months: 9, percent: 30 }],
    [{ months: 0, percent: 25 }, { months: 3, percent: 50 }, { months: 3, percent: 100 }]]) {
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

test('full payment setting accepts a boolean and saves its initial due date', async (t) => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ id: 1, full_payment_due: params[1] }] };
  });
  assert.equal((await invoke(setFullPaymentDue, { params: { id: '1' }, body: { full_payment_due: 'true' } })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await invoke(setFullPaymentDue, { params: { id: '1' }, body: { full_payment_due: true } })).status, 200);
  assert.deepEqual(calls[0].params, [1, true]);
  assert.match(calls[0].sql, /COALESCE\(full_payment_due_date/);
  assert.equal((await invoke(setFullPaymentDue, { params: { id: '1' }, body: { full_payment_due: false } })).status, 200);
  assert.deepEqual(calls[1].params, [1, false]);
});

test('read API scopes receipts to the site, posting rules, today and creator visibility', async (t) => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM plots p')) return { rows: [plot] };
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
  assert.match(receipts.sql, /date AS receipt_date/);
  assert.match(receipts.sql, /payment_date AS receipt_date/);
  assert.match(receipts.sql, /GROUP BY plot_id, installment_id, receipt_date/);
  assert.equal((receipts.sql.match(/financial_transaction_posts/g) || []).length, 2);
  assert.equal(response.data.receipt_scope, 'creator');
  assert.equal(response.data.rows[0].buyer_phone, '9876543210');
  assert.equal(response.data.rows[0].broker_phone, '9123456780');
  assert.match(calls[0].sql, /PLOT_BUYER_MEMBER_JOIN|buyer_link/);
  assert.match(calls[0].sql, /COUNT\(\*\) = 1/);
  assert.match(calls[0].sql, /p\.status, p\.approval_status/);
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
  const req = { params: { id: '1' }, body: { milestones: [{ months: 0, percent: 25 }, { months: 3, percent: 50 }, { months: 6, percent: 100 }] } };
  assert.equal((await invoke(createPercentagePaymentPlan, req)).status, 201);
  assert.deepEqual(calls.find(({ sql }) => sql.includes('INSERT INTO plot_installments')).params[2], [250000, 250000, 500000]);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  exists = true; calls.length = 0;
  assert.equal((await invoke(createPercentagePaymentPlan, req)).status, 409);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.ok(calls.every(({ sql }) => !sql.includes('INSERT INTO')));
});
