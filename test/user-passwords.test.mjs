import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserPasswordHandlers } from '../src/controllers/userPassword.controller.js';
import { comparePassword } from '../src/config/jwt.js';
import requireRole from '../src/middlewares/role.middleware.js';
import { sanitizeAuditValue } from '../src/services/auditLog.service.js';

function response() {
  return {
    statusCode: 200, headers: {},
    status(value) { this.statusCode = value; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

function database({ missing = false, failSessions = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('UPDATE users')) return { rows: missing ? [] : [{ id: params[1] }] };
      if (sql.startsWith('UPDATE user_sessions') && failSessions) throw new Error('Session update failed');
      return { rows: [] };
    },
    release() { released = true; },
  };
  return { calls, connect: async () => client, get released() { return released; } };
}

test('admin and super admin pass the password management role guard; other roles and anonymous callers cannot', () => {
  for (const role of ['admin', 'super_admin', 'sub_admin', 'member', undefined]) {
    const res = response();
    let allowed = false;
    requireRole('admin')({ user: role ? { id: 1, role } : undefined }, res, () => { allowed = true; });
    assert.equal(allowed, ['admin', 'super_admin'].includes(role));
    if (!allowed) assert.equal(res.statusCode, role ? 403 : 401);
  }
});

test('invalid IDs and passwords are rejected before hashing or touching the database', async () => {
  const fail = () => { throw new Error('Must not reach hash/database'); };
  const handlers = createUserPasswordHandlers({ connect: fail }, fail);
  for (const id of ['0', '-1', '1.5', '1junk', '9007199254740992']) {
    const res = response();
    await handlers.updatePassword({ params: { id }, body: { new_password: 'Valid password' } }, res);
    assert.equal(res.statusCode, 400);
  }
  for (const password of [undefined, null, 123456, {}, [], 'short', '      ', '    a ', 'a'.repeat(73), '🔐'.repeat(19)]) {
    const res = response();
    await handlers.updatePassword({ params: { id: '2' }, body: { new_password: password } }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('passwords are hashed and all sessions are revoked in the same transaction, including self resets', async () => {
  const db = database();
  const res = response();
  const password = '  New password 🔐  ';
  await createUserPasswordHandlers(db).updatePassword({ user: { id: 7, role: 'admin' }, params: { id: '7' }, body: { new_password: password } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls[0].sql, 'BEGIN');
  const update = db.calls[1];
  assert.notEqual(update.params[0], password);
  assert.equal(await comparePassword(password, update.params[0]), true);
  assert.equal(update.params[1], 7);
  assert.match(update.sql, /token_version = COALESCE\(token_version, 1\) \+ 1/);
  assert.match(update.sql, /refresh_token = NULL/);
  assert.doesNotMatch(update.sql, /role\s*=|is_active\s*=/);
  assert.match(db.calls[2].sql, /UPDATE user_sessions SET logout_time/);
  assert.deepEqual(db.calls[2].params, [7]);
  assert.equal(db.calls.at(-1).sql, 'COMMIT');
  assert.equal(db.released, true);
  assert.deepEqual(Object.keys(res.body), ['message']);
});

test('missing accounts return 404 and release the transaction', async () => {
  const db = database({ missing: true });
  const res = response();
  await createUserPasswordHandlers(db, async () => 'hash').updatePassword({ params: { id: '8' }, body: { new_password: 'New password' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(db.released, true);
  assert.equal(db.calls.some(({ sql }) => sql.startsWith('UPDATE user_sessions')), false);
});

test('session revocation failure rolls back the password change and releases the connection', async () => {
  const db = database({ failSessions: true });
  await assert.rejects(createUserPasswordHandlers(db, async () => 'hash').updatePassword({ params: { id: '8' }, body: { new_password: 'New password' } }, response()), /Session update failed/);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(db.calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(db.released, true);
});

test('account picker includes every role and blocked users without selecting secrets', async () => {
  const rows = ['super_admin', 'admin', 'sub_admin'].map((role, index) => ({ id: index + 1, name: role, role, email: `${role}@example.com`, is_active: false }));
  const res = response();
  await createUserPasswordHandlers({ async query(sql) {
    assert.match(sql, /SELECT id, name, email, role, is_active FROM users ORDER BY/);
    assert.doesNotMatch(sql, /password|token|WHERE/);
    return { rows };
  } }).listUsers({}, res);
  assert.deepEqual(res.body.users, rows);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('existing audit logging redacts the password reset payload', () => {
  assert.deepEqual(sanitizeAuditValue({ new_password: 'secret password' }), { new_password: '[redacted]' });
});
