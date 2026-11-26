import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { bookingScheduleError, createInstallments, replaceInstallments } from '../src/controllers/installment.controller.js';

const plot = {
  sale_price: 1000000,
  first_installment: 250000,
  booking_date: '2026-09-14',
};
const valid = [
  { amount: 250000, due_date: '2026-09-14' },
  { amount: 750000, due_date: '2027-09-14' },
];

test('new booking schedules keep 25% on the booking date and cover the sale price', () => {
  assert.equal(bookingScheduleError(plot, valid), '');
  assert.match(bookingScheduleError(plot, [{ amount: 250000, due_date: '2026-09-15' }, valid[1]]), /booking date/);
  assert.match(bookingScheduleError(plot, [{ amount: 200000, due_date: '2026-09-14' }, { amount: 800000, due_date: '2027-09-14' }]), /25%/);
  assert.match(bookingScheduleError(plot, [{ amount: 250000, due_date: '2026-09-14' }, { amount: 700000, due_date: '2027-09-14' }]), /full sale price/);
  assert.match(bookingScheduleError(plot, [valid[0]]), /at least one later/);
});

test('historic plots without the canonical first-installment marker keep their existing schedule rules', () => {
  assert.equal(bookingScheduleError({ ...plot, first_installment: 0 }, [{ amount: 1000000, due_date: '2026-10-01' }]), '');
});

test('only Naya Baazar shops accept the first booking installment through day 15', () => {
  const shop = { ...plot, site_id: 7, unit_type: 'shop' };
  for (const due_date of ['2026-09-14', '2026-09-20', '2026-09-29']) {
    assert.equal(bookingScheduleError(shop, [{ ...valid[0], due_date }, valid[1]]), '');
  }
  for (const due_date of ['2026-09-13', '2026-09-30']) {
    assert.match(bookingScheduleError(shop, [{ ...valid[0], due_date }, valid[1]]), /within 15 days/);
  }
  const later = [{ ...valid[0], due_date: '2026-09-29' }, valid[1]];
  assert.match(bookingScheduleError({ ...shop, site_id: 8 }, later), /on the booking date/);
  assert.match(bookingScheduleError({ ...shop, unit_type: 'plot' }, later), /on the booking date/);
});

test('Naya Baazar saves the custom first amount with the schedule and locks it once paid', async t => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE plots (id integer PRIMARY KEY, site_id integer, unit_type text, booking_date date,
      first_installment numeric, sale_price numeric, installments_enabled boolean, approval_requested_by integer);
    INSERT INTO plots VALUES (1091, 7, 'shop', '2026-09-14', 250000, 1000000, true, 4);
    CREATE TABLE plot_installments (id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY, plot_id integer,
      installment_name text, amount numeric, due_date date, sort_order integer, status text,
      paid_amount numeric, updated_at timestamptz);
    CREATE TABLE plot_installment_payments (plot_id integer, installment_id integer);
    CREATE TABLE plot_payments (plot_id integer, amount numeric, status text, payment_type text, cheque_status text);
    CREATE FUNCTION financial_transaction_posts(text, text, text, text) RETURNS boolean LANGUAGE sql AS 'SELECT $2 = ''approved''';
  `);
  t.mock.method(pool, 'connect', async () => ({ query: database.query.bind(database), release() {} }));
  const call = (handler, installments) => new Promise((resolve, reject) => {
    const req = { user: { id: 5 }, params: { id: '1091' }, body: { installments } };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { resolve({ code: this.code, data }); } };
    handler(req, res, reject);
  });
  const rows = [
    { installment_name: 'Deposit', amount: '200000.00', due_date: '2026-09-25', booking_anchor: true },
    { installment_name: 'Installment 2', amount: '800000.00', due_date: '2027-09-14' },
  ];
  const created = await call(createInstallments, rows);
  assert.equal(created.code, 201);
  assert.equal((await call(createInstallments, rows)).code, 200, 'retry returns the existing schedule');
  const saved = rows.map((row, index) => ({ ...row, id: created.data.installments[index].id }));
  const edited = [{ ...saved[0], amount: '300000.00' }, { ...saved[1], amount: '700000.00' }];
  assert.equal((await call(replaceInstallments, edited)).code, 200);
  const readFirstAmount = async () => Number((await database.query('SELECT first_installment FROM plots WHERE id = 1091')).rows[0].first_installment);
  assert.equal(await readFirstAmount(), 300000);

  await database.exec("INSERT INTO plot_payments VALUES (1091, 100000, 'approved', 'BANK', NULL)");
  const rejected = await call(replaceInstallments, saved);
  assert.equal(rejected.code, 409);
  assert.match(rejected.data.message, /locked/);
  assert.equal(await readFirstAmount(), 300000);
});
