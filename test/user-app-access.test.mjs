import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/config/jwt.js';
import pool from '../src/config/db.js';
import userModel from '../src/models/User.model.js';
import { login } from '../src/controllers/auth.controller.js';
import { updateManagedUserAccess } from '../src/controllers/admin.controller.js';

// Exercise the real controller and password check with in-memory user/session state.
const invoke = (handler, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { resolve({ status: this.statusCode, body }); return this; },
  };
  handler(req, res, reject);
});

test('turning off Accounts sign-in does not change Booking access or invalidate its shared token version', async t => {
  const user = { id: 8, role: 'sub_admin', is_active: true, can_login_accounts: true,
    can_login_booking: true, token_version: 4, password: await hashPassword('test-password') };
  let endedAccountSessions = 0;
  t.mock.method(userModel, 'findById', async id => id === user.id ? { ...user } : undefined);
  t.mock.method(userModel, 'update', async (id, updates) => {
    assert.equal(id, user.id);
    Object.assign(user, updates);
    return { ...user };
  });
  t.mock.method(userModel, 'findByLoginIdentifier', async () => ({ ...user }));
  t.mock.method(pool, 'query', async sql => {
    assert.match(sql, /^UPDATE user_sessions SET logout_time/);
    endedAccountSessions++;
    return { rows: [] };
  });

  const change = await invoke(updateManagedUserAccess, {
    params: { id: '8' }, body: { can_login_accounts: false }, user: { id: 1 },
  });
  assert.equal(change.status, 200);
  assert.equal(user.is_active, true);
  assert.equal(user.can_login_booking, true);
  assert.equal(user.token_version, 4);
  assert.equal(endedAccountSessions, 1);

  const denied = await invoke(login, { body: { identifier: 'user@example.test', password: 'test-password' } });
  assert.equal(denied.status, 403);
  assert.match(denied.body.message, /not allowed to sign in to Defence Garden Accounts/);
});
