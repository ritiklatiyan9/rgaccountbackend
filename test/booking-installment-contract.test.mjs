import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingScheduleError } from '../src/controllers/installment.controller.js';

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
