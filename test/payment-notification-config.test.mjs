import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAYMENT_NOTIFICATION_MESSAGE,
  PAYMENT_NOTIFICATION_MODES,
  normalisePaymentNotificationConfig,
  normalisePaymentNotificationMode,
  renderPaymentNotification,
} from '../src/services/plotPaymentNotification.service.js';

test('payment notification defaults are globally off but ready per mode', () => {
  const config = normalisePaymentNotificationConfig(null);

  assert.equal(config.enabled, false);
  assert.deepEqual(Object.keys(config.modes), [...PAYMENT_NOTIFICATION_MODES]);
  assert.equal(config.modes.CASH.enabled, true);
  assert.equal(config.modes.CASH.message, DEFAULT_PAYMENT_NOTIFICATION_MESSAGE);
});

test('a site can disable CASH while customizing another mode', () => {
  const config = normalisePaymentNotificationConfig({
    enabled: true,
    modes: {
      CASH: { enabled: false, message: 'No cash message' },
      UPI: { enabled: true, message: 'Paid {{amount}} by {{mode}} for {{plot_no}}' },
    },
  }, { validate: true });

  assert.equal(config.enabled, true);
  assert.equal(config.modes.CASH.enabled, false);
  assert.equal(config.modes.UPI.message, 'Paid {{amount}} by {{mode}} for {{plot_no}}');
});

test('unknown modes fall back to OTHER and message placeholders render', () => {
  assert.equal(normalisePaymentNotificationMode('crypto'), 'OTHER');
  assert.equal(normalisePaymentNotificationMode(' neft '), 'NEFT');
  assert.equal(normalisePaymentNotificationMode('bank transfer'), 'TRANSFER');
  assert.equal(
    renderPaymentNotification('Hi {{buyer_name}}, Plot {{plot_no}} received {{amount}}.', {
      buyer_name: 'Asha', plot_no: 'A-12', amount: '25,000',
    }),
    'Hi Asha, Plot A-12 received 25,000.'
  );
});

test('saving rejects unknown placeholders and overlong messages', () => {
  assert.throws(
    () => normalisePaymentNotificationConfig({ modes: { CASH: { message: '{{secret}}' } } }, { validate: true }),
    /Unknown placeholder/
  );
  assert.throws(
    () => normalisePaymentNotificationConfig({ modes: { CASH: { message: 'x'.repeat(501) } } }, { validate: true }),
    /500 characters or fewer/
  );
});
