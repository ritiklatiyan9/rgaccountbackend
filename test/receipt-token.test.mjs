import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVerifyUrl,
  signReceiptToken,
  verifyReceiptToken,
} from '../src/utils/receiptToken.js';

test('receipt QR uses the public Defence Garden verification page', () => {
  const previousUrl = process.env.PUBLIC_VERIFY_URL;
  delete process.env.PUBLIC_VERIFY_URL;
  try {
    const verifyUrl = buildVerifyUrl({ t: 'EXP', i: 'expense_42', a: 1250 });
    const parsed = new URL(verifyUrl);
    assert.equal(parsed.origin, 'https://defencegarden.com');
    assert.equal(parsed.pathname, '/verify-receipt');
    assert.ok(parsed.searchParams.get('token'));
  } finally {
    if (previousUrl === undefined) delete process.env.PUBLIC_VERIFY_URL;
    else process.env.PUBLIC_VERIFY_URL = previousUrl;
  }
});

test('Accounts verifies its own signed receipt and rejects a changed signature', () => {
  const previousSecret = process.env.RECEIPT_VERIFY_SECRET;
  process.env.RECEIPT_VERIFY_SECRET = 'accounts-test-secret';
  try {
    const payload = { t: 'PLT', i: 'plot_payment_7', a: 50000 };
    const token = signReceiptToken(payload);
    assert.deepEqual(verifyReceiptToken(token), { valid: true, payload });

    const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    envelope.s = `${envelope.s.slice(0, -1)}${envelope.s.endsWith('0') ? '1' : '0'}`;
    const tampered = Buffer.from(JSON.stringify(envelope)).toString('base64url');
    assert.equal(verifyReceiptToken(tampered).valid, false);
  } finally {
    if (previousSecret === undefined) delete process.env.RECEIPT_VERIFY_SECRET;
    else process.env.RECEIPT_VERIFY_SECRET = previousSecret;
  }
});
