import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { currentTransactionDate } from '../src/services/transactionDate.service.js';
import { createTransfer, approveTransfer, closeTransfer, transferContext, transferInbox } from '../src/services/siteMoneyTransfer.service.js';
import { up as installSiteReceipts } from '../src/migrations/255_site_cash_receipts.js';
import { up as installSiteTransfers } from '../src/migrations/256_site_money_transfers.js';
import { up as installLedgerSelection } from '../src/migrations/257_site_transfer_ledgers.js';
import { fixtureEntry, fixtureLedger, pgliteFixture, siteFunds } from './fixtures/cashflow-money-transfers.mjs';
import { installFunding } from './fixtures/personal-ledger-funding.mjs';

test('approved site transfers post to the exact ledger pair and preserve cash custody', async t => {
  const { db, close } = await pgliteFixture();
  t.after(close);
  await installFunding(db);
  await installSiteReceipts(db);
  await db.query(`ALTER TABLE users ADD COLUMN can_login_accounts boolean DEFAULT true;
    CREATE TABLE bank_accounts(id integer PRIMARY KEY, name text, site_id integer, is_active boolean DEFAULT true);
    UPDATE sites SET name='OM ASSOCIATES' WHERE id=10;
    UPDATE sites SET name='DG ASSOCIATES' WHERE id=11;`);
  const migration = await readFile(new URL('../src/migrations/019_vendor_payment_approval_sync.js', import.meta.url), 'utf8');
  await db.query(migration.match(/CREATE OR REPLACE FUNCTION ensure_site_cashflow_month\([\s\S]*?END;\s*\$\$/)[0]);
  await installSiteTransfers(db);
  const today = currentTransactionDate();
  const { rows: [legacy] } = await db.query(`INSERT INTO site_money_transfers(organization_id,source_site_id,
      destination_site_id,amount,mode,transfer_date,transfer_time,requested_by,approver_id)
    VALUES(1,10,11,10,'cash',$1,'10:00',2,1) RETURNING id`, [today]);
  await installLedgerSelection(db);
  await installLedgerSelection(db);

  const debit = await fixtureLedger(db, { site: 10, name: 'Partner advances', year: 2024 });
  const credit = await fixtureLedger(db, { site: 11, name: 'Partner receipts', year: 2024 });
  const funding = await fixtureLedger(db, { site: 10, name: 'Opening funds', year: 2024 });
  await fixtureEntry(db, funding, { credit: '900000' });
  await fixtureEntry(db, funding, { credit: '100', mode: 'bank' });
  for (const [site, amount] of [[10, '900000'], [11, '1']]) {
    await db.query(`SELECT loyalty_vault_apply_delta('user:1',1,$1,'adjustment','Opening cash',
      'manual_wallet_site_cash_alignment',NULL,NULL,$2,1)`, [amount, site]);
  }
  const requester = { id: 2 };
  const approver = { id: 1 };
  const request = () => ({
    source_site_id: 10, destination_site_id: 11, source_ledger_id: debit.id, destination_ledger_id: credit.id,
    amount: '500000', mode: 'cash', date: today, time: '10:00', approver_id: 1, idempotency_key: randomUUID(),
  });
  const legs = async id => (await db.query(`SELECT site_id, cash_flow_month_id, site_transfer_leg, debit::text, credit::text,
    approved_by, created_by FROM cash_flow_entries WHERE site_transfer_id=$1 ORDER BY site_id`, [id])).rows;
  const custody = async id => (await db.query(`SELECT site_id, amount::text FROM loyalty_vault_entries
    WHERE source_table='site_money_transfers' AND source_id=$1 ORDER BY site_id`, [id])).rows;

  await t.test('ledger options and submission respect site and Cashflow access', async () => {
    const { ledgers } = await transferContext(requester, 10, db);
    assert.ok(ledgers.some(row => row.id === debit.id && row.site_id === 10));
    assert.ok(ledgers.some(row => row.id === credit.id && row.site_id === 11));
    assert.ok(ledgers.some(row => row.id === 'site' && row.site_id === 10));
    assert.ok(!ledgers.some(row => row.site_id === 20));
    assert.ok((await transferContext({ id: 7 }, 10, db)).ledgers.every(row => row.id === 'site'));
    await assert.rejects(createTransfer(requester, { ...request(), destination_ledger_id: debit.id }, db), /credit ledger/i);
    await assert.rejects(createTransfer({ id: 3 }, request(), db), { statusCode: 403 });
    await assert.rejects(createTransfer(requester, { ...request(), approver_id: 2 }, db), /approv/i);
  });

  await t.test('₹5 lakh stays pending until the assigned approver posts both legs once', async () => {
    const body = request();
    const pending = await createTransfer(requester, body, db);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.source_ledger_name, debit.ledger_name);
    assert.equal(pending.destination_ledger_name, credit.ledger_name);
    assert.deepEqual(await legs(pending.id), []);
    assert.deepEqual(await custody(pending.id), []);
    assert.equal((await createTransfer(requester, body, db)).id, pending.id);
    await assert.rejects(createTransfer(requester, { ...body, amount: '20' }, db), { statusCode: 409 });
    await assert.rejects(approveTransfer(requester, pending.id, db), { statusCode: 403 });
    const approved = await approveTransfer(approver, pending.id, db);
    assert.equal(approved.status, 'approved');
    assert.deepEqual(await legs(pending.id), [
      { site_id: 10, cash_flow_month_id: debit.id, site_transfer_leg: 'debit', debit: '500000.00', credit: '0.00', approved_by: 1, created_by: 2 },
      { site_id: 11, cash_flow_month_id: credit.id, site_transfer_leg: 'credit', debit: '0.00', credit: '500000.00', approved_by: 1, created_by: 2 },
    ]);
    assert.deepEqual(await custody(pending.id), [{ site_id: 10, amount: '-500000.00' }, { site_id: 11, amount: '500000.00' }]);
    assert.equal(await siteFunds(db, 10), '400100.00');
    assert.equal(await siteFunds(db, 11), '500000.00');
    await assert.rejects(approveTransfer(approver, pending.id, db), { statusCode: 409 });
    assert.equal((await createTransfer(requester, body, db)).status, 'approved');
    assert.equal((await legs(pending.id)).length, 2);
    assert.equal((await custody(pending.id)).length, 2);
  });

  await t.test('locked selections keep the request pending and rejection makes no entries', async () => {
    const pending = await createTransfer(requester, { ...request(), amount: '15' }, db);
    await db.query('UPDATE cash_flow_months SET is_locked=true WHERE id=$1', [credit.id]);
    await assert.rejects(approveTransfer(approver, pending.id, db), { statusCode: 409 });
    assert.ok((await transferInbox(approver, db)).received.some(row => row.id === pending.id && row.status === 'pending'));
    await db.query('UPDATE cash_flow_months SET is_locked=false WHERE id=$1', [credit.id]);
    await assert.rejects(closeTransfer(requester, pending.id, 'reject', 'Wrong ledger', db), { statusCode: 403 });
    const rejected = await closeTransfer(approver, pending.id, 'reject', 'Wrong ledger', db);
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decision_note, 'Wrong ledger');
    await assert.rejects(approveTransfer(approver, pending.id, db), { statusCode: 409 });
    assert.deepEqual(await legs(rejected.id), []);
    assert.deepEqual(await custody(rejected.id), []);
  });

  await t.test('a stale approval service cannot bypass the requested ledger or mark an unposted request approved', async () => {
    const pending = await createTransfer(requester, { ...request(), amount: '18' }, db);
    const wrongPosting = db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id, site_id, date, particular,
      debit, credit, cash_type, status, approved_by, source_module, site_transfer_id, site_transfer_leg)
      VALUES ($1,10,$2,'Transfer',18,0,'cash','approved',1,'cashflow_transfers',$3,'debit')`, [funding.id, today, pending.id]);
    await assert.rejects(wrongPosting, { constraint: 'site_transfer_posting_mismatch' });
    await assert.rejects(db.query(`UPDATE site_money_transfers SET status='approved',decided_at=now(),decided_by=1
      WHERE id=$1`, [pending.id]), { constraint: 'site_transfer_posting_mismatch' });
    assert.deepEqual(await legs(pending.id), []);
    assert.ok((await transferInbox(approver, db)).received.some(row => row.id === pending.id));
  });

  await t.test('bank transfers preserve each bank mapping and legacy requests retain main ledgers', async () => {
    await db.query("INSERT INTO bank_accounts(id,name,site_id) VALUES(1,'OM bank',10),(2,'DG bank',11)");
    const bank = await createTransfer(requester, { ...request(), mode: 'bank', amount: '28.35',
      source_bank_account_id: 1, destination_bank_account_id: 2, destination_ledger_id: 'site' }, db);
    await approveTransfer(approver, bank.id, db);
    const { rows } = await db.query(`SELECT e.site_id, e.bank_account_id, m.ledger_type, e.cash_type
      FROM cash_flow_entries e JOIN cash_flow_months m ON m.id=e.cash_flow_month_id
      WHERE e.site_transfer_id=$1 ORDER BY e.site_id`, [bank.id]);
    assert.deepEqual(rows, [{ site_id: 10, bank_account_id: 1, ledger_type: 'person', cash_type: 'bank' },
      { site_id: 11, bank_account_id: 2, ledger_type: 'site', cash_type: 'bank' }]);
    assert.deepEqual(await custody(bank.id), []);
    const prior = await approveTransfer(approver, legacy.id, db);
    assert.equal(prior.source_ledger_name, 'Main site ledger');
    const { rows: periods } = await db.query(`SELECT m.ledger_type FROM cash_flow_entries e
      JOIN cash_flow_months m ON m.id=e.cash_flow_month_id WHERE e.site_transfer_id=$1`, [legacy.id]);
    assert.deepEqual(periods.map(row => row.ledger_type), ['site', 'site']);
  });
});
