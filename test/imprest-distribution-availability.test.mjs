import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import { createAllocation, adjustBalance, createTransfer } from '../src/controllers/imprest.controller.js';

function invoke(handler, body) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(value) { status = value; return this; },
      json(data) { resolve({ status, data }); return this; },
    };
    handler({
      body, user: { id: 7, role: 'admin' }, imprestSiteId: 10,
      imprestParticipants: { sub_admin_id: { role: 'sub_admin' }, user_id: { role: 'sub_admin' } },
    }, res, reject);
  });
}

for (const snapshot of [
  { name: 'staff float exceeds recorded cash', cash: 4104280.4, staff: 51079066, pending: 0, amount: 1 },
  { name: 'cash is exhausted', cash: 1000, staff: 1000, pending: 0, amount: 1 },
  { name: 'pending handovers consume available cash', cash: 2000, staff: 1000, pending: 500, amount: 501 },
]) {
  test(`all Admin distribution paths reject when ${snapshot.name}`, async (t) => {
    const queries = [];
    const available = Math.round((snapshot.cash - snapshot.staff - snapshot.pending) * 100) / 100;
    const db = {
      async query(sql, params) {
        queries.push(sql);
        if (sql.startsWith('WITH ledger AS')) return { rows: [{
          cash_balance: snapshot.cash, bank_balance: 99999999,
          imprest_held: snapshot.staff, pending_imprest_reservations: snapshot.pending,
          distributable_balance: available,
        }] };
        if (sql.includes('FROM users u')) return { rows: [{ id: params[0], role: params[0] === 7 ? 'admin' : 'sub_admin', name: 'Participant' }] };
        assert.match(sql.trim(), /^(BEGIN|ROLLBACK|SELECT)\b/, 'rejected distribution must not write');
        return { rows: [] };
      },
      release() {},
    };
    t.mock.method(pool, 'connect', async () => db);
    t.mock.method(pool, 'query', async () => { throw new Error('Unexpected database access'); });
    for (const [handler, body] of [
      [createAllocation, { site_id: 10, sub_admin_id: 6, amount: snapshot.amount, override_reason: 'Temporary funding' }],
      [adjustBalance, { site_id: 10, user_id: 6, amount: snapshot.amount }],
      [createTransfer, { site_id: 10, from_user_id: 7, to_user_id: 6, amount: snapshot.amount }],
    ]) {
      const result = await invoke(handler, body);
      assert.equal(result.status, 400);
      assert.equal(result.data.code, 'INSUFFICIENT_SITE_BALANCE');
      assert.equal(result.data.available ?? result.data.balance, available);
      assert.equal(queries.at(-1), 'ROLLBACK');
      assert.ok(!queries.includes('COMMIT'));
    }
  });
}
