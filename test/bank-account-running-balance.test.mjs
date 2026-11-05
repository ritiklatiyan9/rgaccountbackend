import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { bankAccountEntries } from '../src/controllers/bank.controller.js';

async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE sites(id int,name text); INSERT INTO sites VALUES(7,'Site A'),(8,'Site B');
    CREATE TABLE ledger_entries(id text,bank_account_id int,site_id int,entry_date date,created_at timestamptz,credit numeric,debit numeric);
    INSERT INTO ledger_entries VALUES
      ('a',1,7,'2026-11-03','2026-11-03 09:00Z',1000,0),
      ('b',1,7,'2026-11-04','2026-11-04 09:00Z',0,200),
      ('c',1,7,'2026-11-04','2026-11-04 10:00Z',50,0),
      ('d',1,7,'2026-11-05','2026-11-05 09:00Z',0,25),
      ('other-bank',2,7,'2026-11-05','2026-11-05 09:00Z',99999,0),
      ('other-site',1,8,'2026-11-05','2026-11-05 09:00Z',99999,0);`);
  return db;
}

test('latest transactions are first while each balance accumulates credit minus debit from oldest history', async t => {
  const db = await fixture(t);
  const rows = await bankAccountEntries(db, 1, 7);
  assert.deepEqual(rows.map(row => row.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(rows.map(row => Number(row.balance)), [825, 850, 800, 1000]);
  assert.equal(rows[0].entry_date, '2026-11-05');
});

test('limits and date ranges do not reset the opening balance or pull another bank/site into it', async t => {
  const db = await fixture(t);
  const limited = await bankAccountEntries(db, 1, 7, { limit: 2 });
  assert.deepEqual(limited.map(row => Number(row.balance)), [825, 850]);
  const ranged = await bankAccountEntries(db, 1, 7, { date_from: '2026-11-04', date_to: '2026-11-04' });
  assert.deepEqual(ranged.map(row => row.id), ['c', 'b']);
  assert.deepEqual(ranged.map(row => Number(row.balance)), [850, 800]);
  assert.equal(Number((await bankAccountEntries(db, 2, 7))[0].balance), 99999);
  assert.equal(Number((await bankAccountEntries(db, 1, 8))[0].balance), 99999);
});

test('same-time transactions have stable reverse order and fractional negative balances stay exact', async t => {
  const db = await fixture(t);
  await db.exec(`INSERT INTO ledger_entries VALUES
    ('x',3,7,'2026-11-05','2026-11-05 09:00Z',0.01,0),
    ('y',3,7,'2026-11-05','2026-11-05 09:00Z',0,0.03);`);
  const rows = await bankAccountEntries(db, 3, 7);
  assert.deepEqual(rows.map(row => row.id), ['y', 'x']);
  assert.deepEqual(rows.map(row => Number(row.balance)), [-0.02, 0.01]);
});

test('booking filter follows pool receipts after allotment and preserves full bank balances before display limits', async t => {
  const db = await fixture(t);
  await db.exec(`ALTER TABLE ledger_entries ADD COLUMN source_key text DEFAULT 'expenses',ADD COLUMN source_id int;
    CREATE TABLE pool_money_receipts(id int,plot_payment_id int);
    INSERT INTO pool_money_receipts VALUES(10,30);
    UPDATE ledger_entries SET source_key='pool_money_receipts',source_id=10 WHERE id='a';
    UPDATE ledger_entries SET source_key='plot_payments',source_id=30 WHERE id='c';`);
  const booking = await bankAccountEntries(db, 1, 7, { source: 'booking', limit: 1 });
  assert.deepEqual(booking.map(row => row.id), ['c']);
  assert.equal(Number(booking[0].balance), 850);
  assert.equal(Number(booking[0].bank_balance), 825);
  assert.equal(Number(booking[0].filtered_total_credit), 1050);
  assert.equal(Number(booking[0].filtered_count), 2);
  const other = await bankAccountEntries(db, 1, 7, { source: 'other' });
  assert.deepEqual(other.map(row => row.id), ['d', 'b']);
  assert.deepEqual(other.map(row => Number(row.balance)), [825, 800]);
  await assert.rejects(bankAccountEntries(db, 1, 7, { source: 'invalid' }), { statusCode: 400 });
});
