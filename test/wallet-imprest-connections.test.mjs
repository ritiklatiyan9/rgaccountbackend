import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createWalletImprestTransfer } from '../src/services/walletImprestTransfer.service.js';

const request = () => ({ site_id: 10, from_user_id: 1, to_user_id: 2, amount: '10.15', idempotency_key: randomUUID() });
test('an active transfer connection error is contained, rolled back and discarded', async () => {
  const client = new EventEmitter(), failure = new Error('Socket disconnected');
  const statements = []; let released;
  client.query = async sql => {
    statements.push(sql);
    if (sql.startsWith('SELECT id, name, role')) { client.emit('error', failure); throw failure; }
    return { rows: [] };
  };
  client.release = error => { released = error; };
  await assert.rejects(createWalletImprestTransfer({ id: 1 }, request(), { connect: async () => client }), error => error === failure);
  assert.equal(released, failure); assert.ok(statements.includes('ROLLBACK'));
  assert.equal(client.listenerCount('error'), 0);
  assert.ok(statements.some(sql => sql.includes("lock_timeout='5s'")));
});
test('a failed transfer rollback discards the client and preserves the original error', async () => {
  const client = new EventEmitter(), failure = new Error('Query failed'), rollback = new Error('Rollback failed');
  let released;
  client.query = async sql => {
    if (sql.startsWith('SELECT id, name, role')) throw failure;
    if (sql === 'ROLLBACK') throw rollback;
    return { rows: [] };
  };
  client.release = error => { released = error; };
  await assert.rejects(createWalletImprestTransfer({ id: 1 }, request(), { connect: async () => client }), error => error === failure);
  assert.equal(released, rollback); assert.equal(client.listenerCount('error'), 0);
});
