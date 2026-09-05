import test from 'node:test';
import assert from 'node:assert/strict';
import MasterModel from '../src/models/MasterModel.js';
import { normalizeTransactionTime, transactionTimeMiddleware, transactionTimeContext, transactionTimeForWrite, withTransactionTime } from '../src/services/transactionTime.service.js';

test('time accepts midnight, seconds and unknown legacy values; rejects invalid input', () => {
  assert.equal(normalizeTransactionTime('00:00'), '00:00:00');
  assert.equal(normalizeTransactionTime('23:59:59'), '23:59:59');
  for (const input of [null, '', 'unknown']) assert.equal(normalizeTransactionTime(input), null);
  for (const input of ['24:00', '12:60', '12:00:60', 'noon', '2026-09-05T12:00:00Z', '12:00:00; DROP TABLE x']) {
    assert.throws(() => normalizeTransactionTime(input), { statusCode: 400 });
  }
});

test('concurrent requests retain their own time through asynchronous writes', async () => {
  const model = new MasterModel('expenses');
  const run = (header, pause) => new Promise((resolve, reject) => {
    transactionTimeMiddleware({ method: 'POST', body: {}, get: () => header }, {}, async () => {
      try {
        await new Promise(done => setTimeout(done, pause));
        const calls = [];
        const db = { query: async (sql, args) => { calls.push({ sql, args }); return { rows: [{}] }; } };
        await model.create({ credit: 100 }, db);
        await model.update(3, { credit: 200 }, db);
        resolve(calls);
      } catch (error) { reject(error); }
    });
  });
  const [first, second] = await Promise.all([run('09:15:01', 20), run('18:30:42', 1)]);
  for (const [calls, time] of [[first, '09:15:01'], [second, '18:30:42']]) {
    assert.match(calls[0].sql, /credit, transaction_time/);
    assert.deepEqual(calls[0].args, [100, time]);
    assert.deepEqual(calls[1].args, [200, time, 3]);
  }
  assert.equal(transactionTimeContext.getStore(), undefined);
});

test('omitted time preserves existing values; explicit clearing and approval data work', () => {
  assert.equal(transactionTimeForWrite(null), null);
  assert.deepEqual(withTransactionTime('expenses', { remark: 'x' }), { remark: 'x' });
  transactionTimeContext.run({ supplied: true, value: null }, () => {
    assert.equal(transactionTimeForWrite('10:00:00'), null);
    assert.deepEqual(withTransactionTime('expenses', { remark: 'x' }), { remark: 'x', transaction_time: null });
    assert.deepEqual(withTransactionTime('members', { name: 'x' }), { name: 'x' });
    assert.equal(withTransactionTime('expenses', { transaction_time: '08:00' }).transaction_time, '08:00:00');
  });
});

test('body and multipart header use the same validation before any write', () => {
  let called = false;
  transactionTimeMiddleware({ method: 'PUT', get: () => undefined, body: { transaction_time: '17:12' } }, {}, () => {
    called = true;
    assert.equal(transactionTimeForWrite(), '17:12:00');
  });
  assert.ok(called);
  transactionTimeMiddleware({ method: 'POST', get: () => '25:00' }, {
    status(code) { assert.equal(code, 400); return this; },
    json(body) { assert.match(body.message, /valid time/); },
  }, () => assert.fail('invalid time reached write handler'));
});
