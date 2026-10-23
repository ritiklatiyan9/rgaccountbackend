import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountWhatsAppHooks, accountWhatsAppHooks } from '../src/services/accountWhatsAppHooks.service.js';
import { accountPaymentEvent, classifyAccountWhatsAppPayment } from '../src/services/accountWhatsAppWorkflow.policy.js';
import pool from '../src/config/db.js';
import { approveEntry, bulkApprove } from '../src/controllers/approval.controller.js';

const payment = { id: 41, site_id: 5, plot_id: 8, amount: 10000, status: 'approved', payment_type: 'BANK' };
const approvedPlot = { id: 8, site_id: 5, status: 'BOOKED', approval_status: 'approved' };

for (const mode of ['CASH', ' cash ', '', null, undefined, 'OTHER', 'ADJUST', 'REFUND']) {
  test(`payment mode ${JSON.stringify(mode)} cannot queue a WhatsApp transaction`, async () => {
    const queued = [];
    const hooks = createAccountWhatsAppHooks(async (...args) => queued.push(args));
    await hooks.paymentApproved('plot_payment', { ...payment, payment_type: mode, payment_from: 'UPI' });
    await hooks.paymentApproved('plot_payment', { ...payment, payment_type: mode, amount: -10000 });
    await hooks.paymentApproved('plot_installment_payment', { ...payment, payment_mode: mode });
    assert.equal(queued.length, 0);
  });
}

test('canonical source distinguishes receipts, client refunds and installment receipts without overlapping IDs', async () => {
  const queued = [];
  const hooks = createAccountWhatsAppHooks(async (...args) => queued.push(args));
  await hooks.paymentApproved('plot_payment', payment);
  await hooks.paymentApproved('plot_payment', { ...payment, amount: -500 });
  await hooks.paymentApproved('plot_installment_payment', { ...payment, payment_mode: 'UPI' });
  await hooks.paymentApproved('farmer_payment', payment);
  assert.deepEqual(queued.map(([event, id, options]) => [event, id, options.dedupeKey]), [
    ['PAYMENT_RECEIVED', 41, 'PAYMENT_RECEIVED:41'],
    ['PAYMENT_SENT', 41, 'PAYMENT_SENT:41'],
    ['INSTALLMENT_RECEIVED', 41, 'INSTALLMENT_RECEIVED:41'],
  ]);
});

test('pending, rejected, invalid amounts and uncleared cheques never issue a receipt', () => {
  for (const status of ['pending', 'rejected', '', null]) {
    assert.equal(accountPaymentEvent('plot_payment', { ...payment, status }), null);
  }
  for (const amount of [0, null, '', 'invalid', Infinity]) {
    assert.equal(accountPaymentEvent('plot_payment', { ...payment, amount }), null);
  }
  for (const mode of ['BANK', 'CHEQUE']) {
    for (const cheque_status of ['PENDING', 'BOUNCED', 'RETURNED']) {
      assert.equal(accountPaymentEvent('plot_payment', { ...payment, payment_type: mode, cheque_status }), null);
    }
  }
  assert.equal(classifyAccountWhatsAppPayment('PAYMENT_RECEIVED', { ...payment, payment_type: 'CHEQUE', cheque_status: null }), false);
  assert.equal(accountPaymentEvent('plot_payment', { ...payment, payment_type: 'CHEQUE', cheque_status: 'CLEARED' }), 'PAYMENT_RECEIVED');
  assert.equal(classifyAccountWhatsAppPayment('PAYMENT_SENT', payment), false);
  assert.equal(classifyAccountWhatsAppPayment('INSTALLMENT_RECEIVED', { ...payment, payment_mode: 'UPI', amount: -1 }), false);
  assert.equal(accountPaymentEvent('plot_payment', { ...payment, money_transfer_id: 'internal-transfer' }), null);
  assert.equal(accountPaymentEvent('plot_payment', { ...payment, entry_transfer_id: 'module-move' }), null);
});

test('only active clients get onboarding and approved booking transitions suppress metadata edits', async () => {
  const queued = [];
  const hooks = createAccountWhatsAppHooks(async (...args) => queued.push(args));
  await hooks.clientOnboarded({ id: 9, site_id: 5, member_type: 'FARMER' });
  await hooks.clientOnboarded({ id: 9, site_id: 5, member_type: 'CLIENT', status: 'INACTIVE' });
  await hooks.clientOnboarded({ id: 9, site_id: 5, member_types: ['FARMER', 'CLIENT'], status: 'ACTIVE' });
  await hooks.plotBooked({ ...approvedPlot, approval_status: 'pending' });
  await hooks.plotBooked(approvedPlot, { status: 'BOOKED' });
  await hooks.plotBooked(approvedPlot, { status: 'COMPANY' });
  assert.deepEqual(queued.map(([event]) => event), ['CLIENT_ONBOARDED', 'PLOT_BOOKED']);
});

test('clearance waits for payment approval and registry congratulations require a completed registry date', async () => {
  const queued = [];
  const hooks = createAccountWhatsAppHooks(async (...args) => queued.push(args));
  await hooks.chequeCommitted('plot_payment', { after: { ...payment, status: 'pending', payment_type: 'CHEQUE', cheque_status: 'CLEARED' } });
  await hooks.chequeCommitted('plot_payment', { after: { ...payment, payment_type: 'CHEQUE', cheque_status: 'CLEARED' } });
  await hooks.registryCompleted({ id: 12, site_id: 5 });
  await hooks.registryCompleted({ id: 12, site_id: 5, registry_date: '2026-10-23' });
  assert.deepEqual(queued.map(([event]) => event), ['PAYMENT_RECEIVED', 'REGISTRY_COMPLETED']);
});

test('outbox failure cannot reject a committed business action', async () => {
  const hooks = createAccountWhatsAppHooks(async () => { throw new Error('Test outbox unavailable'); });
  const log = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await hooks.paymentApproved('plot_payment', payment), { queued: false, reason: 'queue_failed' });
  } finally { console.error = log; }
});

const invoke = (handler, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
  handler(req, res, reject);
});

test('single and bulk plot approvals queue only after the atomic decision succeeds', async (t) => {
  const originalQuery = pool.query;
  const originalHooks = { ...accountWhatsAppHooks };
  const queued = [];
  let decisionCommitted = false;
  Object.assign(accountWhatsAppHooks, createAccountWhatsAppHooks(async (event, id, options) => {
    assert.equal(decisionCommitted, true, 'outbox cannot precede the approval write');
    queued.push({ event, id, options });
    return { queued: true };
  }));
  t.after(() => { pool.query = originalQuery; Object.assign(accountWhatsAppHooks, originalHooks); });

  let changed = true;
  pool.query = async (sql) => {
    if (sql.startsWith('SELECT * FROM plot_status_approvals')) return { rows: [{ id: 8, site_id: 5, status: 'pending', plot_status: 'BOOKED' }] };
    if (sql.includes('UPDATE plot_status_approvals SET status')) {
      decisionCommitted = changed;
      return { rows: changed ? [{ id: 8, site_id: 5, status: 'approved', plot_status: 'BOOKED', approval_original_data: { status: 'COMPANY' } }] : [], rowCount: changed ? 1 : 0 };
    }
    throw new Error(`Unexpected query in isolated approval fixture: ${sql}`);
  };
  const user = { id: 1, role: 'admin', organization_id: 1 };
  let result = await invoke(approveEntry, { params: { id: '8' }, query: { source: 'plot_status' }, user });
  assert.equal(result.status, 200);
  assert.deepEqual(queued.map(({ event }) => event), ['PLOT_BOOKED']);

  changed = false;
  decisionCommitted = false;
  result = await invoke(approveEntry, { params: { id: '8' }, query: { source: 'plot_status' }, user });
  assert.equal(result.status, 409);
  assert.equal(queued.length, 1, 'racing approval must not enqueue');

  changed = true;
  result = await invoke(bulkApprove, { body: { items: [{ id: 8, source: 'plot_status' }] }, user });
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.deepEqual(queued.map(({ event }) => event), ['PLOT_BOOKED', 'PLOT_BOOKED']);
});
