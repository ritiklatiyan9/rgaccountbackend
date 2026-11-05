import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadUnrecordedPoolCheques } from '../src/services/poolMoneyCheques.service.js';
import { bankBookingPending } from '../src/services/bankBookingMoney.service.js';

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id int,organization_id int);INSERT INTO sites VALUES(7,1),(8,2);
    CREATE TABLE members(id int,full_name text);INSERT INTO members VALUES(1,'Applicant One'),(2,'Applicant Two');
    CREATE TABLE draw_registrations(id int,site_id int,client_member_id int,registration_no text,status text,booking_id int);
    INSERT INTO draw_registrations VALUES(1,7,1,'DRW-001','REGISTERED',NULL),(2,7,2,'DRW-002','REGISTERED',NULL),
      (3,8,1,'OTHER-ORG','REGISTERED',NULL),(4,7,1,'CANCELLED-HELD','CANCELLED',NULL);
    CREATE TABLE draw_payments(id int,draw_registration_id int,receipt_no text,payment_date date,amount numeric,
      payment_from text,cheque_no text,bank_name text,plot_payment_id int);
    INSERT INTO draw_payments VALUES(10,1,'RC-001','2026-10-22',100000,'CHEQUE','CH001','Bank A',NULL),
      (11,2,'RC-002','2026-11-03',100000,'CHEQUE','CH002','Bank B',NULL),
      (12,3,'OTHER-ORG','2026-11-03',300000,'CHEQUE','CH003','Bank B',NULL),
      (13,1,'CASH','2026-11-03',20000,'CASH',NULL,NULL,NULL),
      (14,4,'CANCELLED-RC','2026-11-03',50000,'CHEQUE','CH004','Bank B',NULL);
    CREATE TABLE bookings(id int,site_id int,client_member_id int,booking_no text,buyer_name text,booking_date date,
      plot_id int,token_amount numeric,token_payment_from text,token_cheque_no text,token_bank_name text,token_payment_id int,status text);
    INSERT INTO bookings VALUES(9,7,1,'BK0009','Applicant One','2026-11-04',NULL,25000,'CHEQUE','CH009','Bank C',NULL,'DRAFT');`);
  return db;
}

test('unrecorded Booking cheques appear without posting money and respect site, organization and status', async t => {
  const db = await fixture(t);
  const entries = await loadUnrecordedPoolCheques(db, 1, 7);
  assert.equal(entries.length, 4);
  assert.equal(entries.reduce((sum, row) => sum + Number(row.amount), 0), 275000);
  assert.equal(entries.find(row => row.source_id === 10).reference, 'DRW-001');
  assert.equal(entries.find(row => row.source_id === 10).date, '2026-10-22');
  assert.equal(entries.find(row => row.kind === 'booking').reference, 'BK0009');
  assert.equal(entries.find(row => row.source_id === 14).registration_status, 'CANCELLED');
  assert.ok(entries.every(row => row.recorded === false));
  assert.deepEqual(await loadUnrecordedPoolCheques(db, 2, 7), []);
  assert.deepEqual(await loadUnrecordedPoolCheques(db, 1, 8), []);
  assert.deepEqual(await loadUnrecordedPoolCheques(db, 1, 7, 'CLEARED'), []);
  assert.equal((await db.query("SELECT to_regclass('pool_money_receipts') AS table_name")).rows[0].table_name, null);
});

test('recorded or allotted receipts disappear from the import list rather than appearing twice', async t => {
  const db = await fixture(t);
  await db.exec(`CREATE TABLE pool_money_receipts(source_kind text,source_id int);
    INSERT INTO pool_money_receipts VALUES('draw',10),('booking',9);
    UPDATE draw_payments SET plot_payment_id=100 WHERE id=11;`);
  const entries = await loadUnrecordedPoolCheques(db, 1, 7);
  assert.deepEqual(entries.map(row => row.source_id), [14]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_receipts')).rows[0].n, 2);
});

test('an Accounts installation without Booking Software returns an empty import list', async t => {
  const db = new PGlite(); t.after(() => db.close());
  assert.deepEqual(await loadUnrecordedPoolCheques(db, 1, 7), []);
});

test('bank booking filter shows only the selected bank’s pending receipts and respects explicit bank IDs', async t => {
  const db = await fixture(t);
  await db.exec(`CREATE TABLE bank_accounts(id int,site_id int,name text);
    INSERT INTO bank_accounts VALUES(1,7,'Bank A'),(2,7,'Bank B'),(3,7,'Bank C');
    ALTER TABLE draw_payments ADD COLUMN bank_account_id int;`);
  const bank = { id: 1, name: 'Bank A' };
  const receipts = await bankBookingPending(db, 1, 7, bank);
  assert.deepEqual(receipts.map(row => row.source_id), [10]);
  assert.equal(receipts[0].posting_state, 'AWAITING_ACCOUNTS');
  await db.exec('UPDATE draw_payments SET bank_account_id=2 WHERE id=10');
  assert.deepEqual(await bankBookingPending(db, 1, 7, bank), []);
  await db.exec("UPDATE draw_payments SET bank_account_id=NULL WHERE id=10;INSERT INTO bank_accounts VALUES(4,7,'BANK A');");
  assert.deepEqual(await bankBookingPending(db, 1, 7, bank), [], 'ambiguous names cannot silently assign a receipt');
  assert.deepEqual(await bankBookingPending(db, 2, 7, bank), []);
});

test('recorded uncleared cheques are shown outside the balance and disappear from pending after posting', async t => {
  const db = await fixture(t);
  await db.exec(`CREATE TABLE bank_accounts(id int,site_id int,name text);INSERT INTO bank_accounts VALUES(1,7,'Bank A');
    CREATE TABLE pool_money_receipts(id int,source_kind text,owner_id int,source_id int,reference text,buyer_name text,date date,
      amount numeric,payment_from text,bank_name text,cheque_no text,bank_account_id int,status text,cheque_status text,
      payment_type text,plot_payment_id int,site_id int);
    INSERT INTO pool_money_receipts VALUES(100,'draw',1,10,'RC-001','Applicant One','2026-10-22',100000,'CHEQUE','Bank A','CH001',1,'pending','PENDING','CHEQUE',NULL,7);
    CREATE TABLE cash_flow_entries(source_module text,source_id int,bank_account_id int,status text,cheque_status text);
    INSERT INTO cash_flow_entries VALUES('pool_money_receipts',100,1,'pending','PENDING');
    CREATE TABLE ledger_entries(site_id int,bank_account_id int,source_key text,source_id int,credit numeric,debit numeric);
    INSERT INTO ledger_entries VALUES(7,1,'pool_money_receipts',100,0,0);`);
  const bank = { id: 1, name: 'Bank A' };
  const pending = await bankBookingPending(db, 1, 7, bank);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].recorded, true);
  assert.equal(pending[0].posting_state, 'AWAITING_CHEQUE_CLEARANCE');
  assert.deepEqual(await bankBookingPending(db, 2, 7, bank), []);
  await db.exec('UPDATE ledger_entries SET credit=100000');
  assert.deepEqual(await bankBookingPending(db, 1, 7, bank), [], 'the same receipt cannot be pending and included in bank credits');
});
