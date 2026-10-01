import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up } from '../src/migrations/185_cash_wallets.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import {
  createWalletTransfer, resolveWalletTransfer, walletAmount, walletUser,
} from '../src/services/wallet.service.js';

test('cash handovers preserve exact balances, enforce custody permissions and roll back atomically', {
  skip: !process.env.PGLITE_MODULE,
}, async () => {
  // An isolated in-memory PostgreSQL database: no application records, network
  // connections or production sequences are read or changed by this test.
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, params) => {
    const result = params ? await pg.query(sql, params) : (await pg.exec(sql)).at(-1);
    return { ...result, rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const database = { query, connect: async () => ({ query, release() {} }) };
  const sender = { id: 1, role: 'sub_admin' };
  const admin = { id: 2, role: 'admin' };
  const superAdmin = { id: 3, role: 'super_admin' };
  const request = (recipient_id, amount, note = '') => ({ recipient_id, amount, note, idempotency_key: randomUUID() });
  const balance = async id => (await query('SELECT balance::text, reserved_balance::text FROM wallet_accounts WHERE user_id=$1', [id])).rows[0];
  const entryCount = async () => Number((await query('SELECT count(*) AS count FROM wallet_entries')).rows[0].count);
  const transferStatus = async id => (await query('SELECT status FROM wallet_transfers WHERE id=$1', [id])).rows[0].status;
  const statusError = status => error => error.statusCode === status;
  try {
    await query(`CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      CREATE TABLE cash_flow_entries(id integer PRIMARY KEY,created_at timestamptz DEFAULT now(),created_by integer,
        credit numeric DEFAULT 0,debit numeric DEFAULT 0,cash_type text,particular text,status text DEFAULT 'pending',source_module text,source_id integer);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      INSERT INTO users(id,name,role,organization_id,is_active) VALUES
        (1,'Accountant','sub_admin',10,true),(2,'Administrator','admin',10,true),(3,'Owner','super_admin',10,true),
        (4,'Other accountant','sub_admin',10,true),(5,'Outside admin','admin',20,true),
        (6,'Inactive admin','admin',10,false),(7,'Member','member',10,true);`);
    await query(postingPolicySql);
    await up(database);
    await up(database);
    // Seed through the real capture trigger rather than manually assigning a
    // balance: this also verifies the service sees newly received cash.
    await query("INSERT INTO cash_flow_entries(id,created_by,credit,cash_type,particular) VALUES(101,1,1000.25,'cash','Client collection')");
    assert.deepEqual(await balance(1), { balance: '1000.25', reserved_balance: '0.00' });
    assert.equal(walletAmount('0004.1'), '4.10');
    for (const value of ['0', '-1', '1.001', '1e3', 'NaN', 'Infinity', '', null, '10000000000000']) {
      assert.throws(() => walletAmount(value), statusError(400), `Reject invalid amount ${value}`);
    }
    assert.equal((await walletUser({ id: 1, role: 'super_admin', organization_id: 20 }, database)).role, 'sub_admin');
    await assert.rejects(createWalletTransfer({ id: 6, role: 'super_admin' }, request(2, '1'), database), statusError(403));
    await assert.rejects(createWalletTransfer({ id: 7, role: 'admin' }, request(2, '1'), database), statusError(403));
    await assert.rejects(createWalletTransfer(sender, request(1, '1'), database), statusError(400));
    await assert.rejects(createWalletTransfer(sender, request(5, '1'), database), statusError(403));
    await assert.rejects(createWalletTransfer(sender, request(6, '1'), database), statusError(403));
    await assert.rejects(createWalletTransfer(sender, request(7, '1'), database), statusError(403));

    const firstRequest = request(2, '400.10', 'Collected cash handed over');
    const first = await createWalletTransfer(sender, firstRequest, database);
    const firstId = first.transfer.id;
    assert.equal(first.replayed, false);
    assert.deepEqual(await balance(1), { balance: '1000.25', reserved_balance: '400.10' });
    assert.deepEqual(await balance(2), { balance: '0.00', reserved_balance: '0.00' });
    assert.equal(await entryCount(), 1, 'Pending handover moves no cash');
    const duplicate = await createWalletTransfer(sender, firstRequest, database);
    assert.equal(duplicate.transfer.id, firstId);
    assert.equal(duplicate.replayed, true);
    await assert.rejects(createWalletTransfer(sender, { ...firstRequest, amount: '400.11' }, database), statusError(409));
    await assert.rejects(createWalletTransfer(sender, request(3, '600.16'), database), statusError(409));
    await assert.rejects(resolveWalletTransfer(superAdmin, firstId, 'accept', {}, database), statusError(404));
    await assert.rejects(resolveWalletTransfer({ ...sender, role: 'super_admin' }, firstId, 'accept', {}, database), statusError(403));
    await assert.rejects(resolveWalletTransfer(admin, firstId, 'cancel', {}, database), statusError(403));
    await assert.rejects(resolveWalletTransfer({ id: 5, role: 'super_admin' }, firstId, 'accept', {}, database), statusError(404));
    await resolveWalletTransfer(admin, firstId, 'accept', {}, database);
    assert.deepEqual(await balance(1), { balance: '600.15', reserved_balance: '0.00' });
    assert.deepEqual(await balance(2), { balance: '400.10', reserved_balance: '0.00' });
    assert.equal(await entryCount(), 3);
    assert.equal((await resolveWalletTransfer(admin, firstId, 'accept', {}, database)).replayed, true);
    assert.equal(await entryCount(), 3, 'Acceptance retry does not mint cash');
    await assert.rejects(resolveWalletTransfer(admin, firstId, 'reject', {}, database), statusError(409));
    const second = await createWalletTransfer(admin, request(3, '150.05'), database);
    await resolveWalletTransfer(superAdmin, second.transfer.id, 'accept', {}, database);
    assert.deepEqual(await balance(2), { balance: '250.05', reserved_balance: '0.00' });
    assert.deepEqual(await balance(3), { balance: '150.05', reserved_balance: '0.00' });
    assert.equal((await query('SELECT sum(balance)::text AS total FROM wallet_accounts')).rows[0].total, '1000.25');
    assert.equal(Number((await query("SELECT sum(amount) AS total FROM wallet_entries WHERE kind IN ('transfer_in','transfer_out')")).rows[0].total), 0);

    const rejectable = await createWalletTransfer(sender, request(2, '50'), database);
    const cancellable = await createWalletTransfer(sender, request(3, '50'), database);
    assert.equal((await balance(1)).reserved_balance, '100.00');
    const beforeReject = await entryCount();
    await resolveWalletTransfer(admin, rejectable.transfer.id, 'reject', { note: 'Cash not received' }, database);
    assert.equal((await balance(1)).reserved_balance, '50.00');
    assert.equal((await resolveWalletTransfer(admin, rejectable.transfer.id, 'reject', {}, database)).replayed, true);
    await resolveWalletTransfer(sender, cancellable.transfer.id, 'cancel', { note: 'Handover postponed' }, database);
    assert.deepEqual(await balance(1), { balance: '600.15', reserved_balance: '0.00' });
    assert.equal(await entryCount(), beforeReject, 'Reject/cancel release holds without posting cash');

    // A failure on the receiving side must undo the already-attempted debit,
    // preserve the hold and leave the handover pending for a safe retry.
    const interrupted = await createWalletTransfer(admin, request(3, '10.25'), database);
    const beforeFailure = { sender: await balance(2), recipient: await balance(3), entries: await entryCount() };
    await query(`CREATE FUNCTION fail_test_wallet_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='transfer_in' THEN RAISE EXCEPTION 'Simulated receiving-side storage failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_test_wallet_receipt BEFORE INSERT ON wallet_entries FOR EACH ROW EXECUTE FUNCTION fail_test_wallet_receipt();`);
    await assert.rejects(resolveWalletTransfer(superAdmin, interrupted.transfer.id, 'accept', {}, database), /Simulated receiving-side storage failure/);
    assert.deepEqual(await balance(2), beforeFailure.sender);
    assert.deepEqual(await balance(3), beforeFailure.recipient);
    assert.equal(await entryCount(), beforeFailure.entries);
    assert.equal(await transferStatus(interrupted.transfer.id), 'pending');
    await query('DROP TRIGGER fail_test_wallet_receipt ON wallet_entries');
    await resolveWalletTransfer(admin, interrupted.transfer.id, 'cancel', {}, database);

    // Receipt corrections remain visible even after custody moved elsewhere.
    // A pending recipient may not accept cash that no longer exists.
    const nowUnfunded = await createWalletTransfer(sender, request(2, '50'), database);
    await query('UPDATE cash_flow_entries SET credit=300.00 WHERE id=101');
    assert.deepEqual(await balance(1), { balance: '-100.10', reserved_balance: '50.00' });
    await assert.rejects(createWalletTransfer(sender, request(2, '0.01'), database), statusError(409));
    await assert.rejects(resolveWalletTransfer(admin, nowUnfunded.transfer.id, 'accept', {}, database), statusError(409));
    assert.equal(await transferStatus(nowUnfunded.transfer.id), 'pending');
    await resolveWalletTransfer(sender, nowUnfunded.transfer.id, 'cancel', {}, database);
    assert.deepEqual(await balance(1), { balance: '-100.10', reserved_balance: '0.00' });
    assert.equal((await query('SELECT sum(balance)::text AS total FROM wallet_accounts')).rows[0].total, '300.00');
    assert.equal((await query("SELECT amount::text FROM wallet_entries WHERE kind='adjustment'")).rows[0].amount, '-700.25');
    await assert.rejects(query("UPDATE wallet_entries SET description='Changed history' WHERE id=1"), error => error.constraint === 'wallet_immutable_history');
  } finally {
    await pg.close();
  }
});
