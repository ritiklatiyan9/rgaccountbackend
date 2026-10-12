import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signOAuthState, verifyOAuthState } from '../src/utils/googleOAuthState.js';

test('local and hosted OAuth key whitespace agrees while legacy states and tamper checks remain valid', () => {
  const before = process.env.CALENDAR_TOKEN_ENC_KEY;
  try {
    process.env.CALENDAR_TOKEN_ENC_KEY = 'a'.repeat(64);
    const state = signOAuthState({ orgId: 1, userId: 2, origin: 'http://127.0.0.1:5174' });
    process.env.CALENDAR_TOKEN_ENC_KEY = `  ${'a'.repeat(64)}\n`;
    assert.equal(verifyOAuthState(state)?.orgId, 1);
    const [payload] = state.split('.');
    const legacy = `${payload}.${crypto.createHmac('sha256', process.env.CALENDAR_TOKEN_ENC_KEY).update(payload).digest('base64url')}`;
    assert.equal(verifyOAuthState(legacy)?.userId, 2);
    assert.equal(verifyOAuthState(`${payload}.invalid`), null);
    process.env.CALENDAR_TOKEN_ENC_KEY = 'b'.repeat(64);
    assert.equal(verifyOAuthState(state), null);
  } finally {
    if (before === undefined) delete process.env.CALENDAR_TOKEN_ENC_KEY;
    else process.env.CALENDAR_TOKEN_ENC_KEY = before;
  }
});
