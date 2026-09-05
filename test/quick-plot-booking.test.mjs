import assert from 'node:assert/strict';
import test from 'node:test';
import { withCompanyPlotBooking } from '../src/services/quickPlotBooking.service.js';

function fixture({ status = 'COMPANY', member = { id: 8, full_name: ' New Buyer ' }, missingPlot = false } = {}) {
  const calls = [];
  let committed = { plot: missingPlot ? null : { id: 12, site_id: 4, status, buyer_name: 'COMPANY', booking_by: 'EXISTING DEALER' }, payments: [] };
  let pending;
  let released = false;
  const connection = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN') pending = structuredClone(committed);
      else if (sql === 'COMMIT') committed = pending;
      else if (sql === 'ROLLBACK') pending = undefined;
      else if (sql.startsWith('SELECT * FROM plots')) {
        assert.match(sql, /FOR UPDATE/);
        return { rows: pending.plot ? [pending.plot] : [] };
      } else if (sql.includes('FROM members')) {
        assert.match(sql, /site_id = \$2 AND status = 'ACTIVE' FOR SHARE/);
        assert.deepEqual(params, [8, 4]);
        return { rows: member ? [member] : [] };
      } else if (sql.startsWith('UPDATE plots')) {
        pending.plot = { ...pending.plot, status: 'BOOKED', buyer_name: params[1], booking_date: params[2] };
        return { rows: [pending.plot] };
      } else throw new Error(`Unexpected query: ${sql}`);
      return { rows: [] };
    },
    release() { released = true; },
  };
  return {
    calls,
    state: () => committed,
    released: () => released,
    options: {
      pool: { connect: async () => connection }, plotId: 12, memberId: '8', date: '2026-09-05',
      savePayment: async (db) => {
        assert.equal(db, connection, 'payment must use the booking transaction connection');
        assert.equal(pending.plot.status, 'BOOKED', 'booking must precede payment');
        const payment = { id: 24, buyer_name: pending.plot.buyer_name, booked_by: pending.plot.booking_by };
        pending.payments.push(payment);
        return { rows: [payment] };
      },
    },
  };
}

test('books the selected user and saves payment in the same transaction', async () => {
  const f = fixture();
  const { bookedPlot, result } = await withCompanyPlotBooking(f.options);
  assert.equal(bookedPlot.status, 'BOOKED');
  assert.equal(bookedPlot.booking_date, '2026-09-05');
  assert.equal(result.rows[0].buyer_name, 'NEW BUYER');
  assert.equal(result.rows[0].booked_by, 'EXISTING DEALER');
  assert.equal(f.state().payments.length, 1);
  assert.equal(f.calls.at(-1).sql, 'COMMIT');
  assert.equal(f.released(), true);
});

test('payment failure rolls back the booking and releases the connection', async () => {
  const f = fixture();
  const failure = new Error('Payment rejected');
  await assert.rejects(withCompanyPlotBooking({ ...f.options, savePayment: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(f.state().plot.status, 'COMPANY');
  assert.equal(f.state().plot.buyer_name, 'COMPANY');
  assert.deepEqual(f.state().payments, []);
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(f.released(), true);
});

test('a booking already taken by another operator cannot be overwritten or paid again', async () => {
  const f = fixture({ status: 'BOOKED' });
  let paymentCalls = 0;
  await assert.rejects(withCompanyPlotBooking({ ...f.options, savePayment: async () => { paymentCalls++; } }), { status: 409, code: 'PLOT_BOOKING_CHANGED' });
  assert.equal(paymentCalls, 0);
  assert.equal(f.calls.some(({ sql }) => sql.startsWith('UPDATE plots')), false);
  assert.equal(f.released(), true);
});

test('an inactive, deleted or foreign-site buyer cannot book the plot', async () => {
  const f = fixture({ member: null });
  await assert.rejects(withCompanyPlotBooking(f.options), { status: 400, code: 'BOOKING_CLIENT_UNAVAILABLE' });
  assert.equal(f.state().plot.status, 'COMPANY');
  assert.equal(f.calls.some(({ sql }) => sql.startsWith('UPDATE plots')), false);
  assert.equal(f.released(), true);
});

test('missing plots fail before buyer lookup and payment', async () => {
  const f = fixture({ missingPlot: true });
  await assert.rejects(withCompanyPlotBooking(f.options), { status: 404, code: 'PLOT_NOT_FOUND' });
  assert.equal(f.calls.some(({ sql }) => sql.includes('FROM members')), false);
  assert.equal(f.released(), true);
});

test('empty payment results also roll back the booking', async () => {
  const f = fixture();
  await assert.rejects(withCompanyPlotBooking({ ...f.options, savePayment: async () => ({ rows: [] }) }), { status: 409, code: 'PLOT_BOOKING_CHANGED' });
  assert.equal(f.state().plot.status, 'COMPANY');
  assert.equal(f.released(), true);
});

test('invalid buyer IDs fail before acquiring a database connection', async () => {
  for (const memberId of [null, '', 0, -1, 2.5, '8abc', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture();
    await assert.rejects(withCompanyPlotBooking({ ...f.options, memberId }), { status: 400, code: 'BOOKING_CLIENT_REQUIRED' });
    assert.deepEqual(f.calls, []);
  }
});
