import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { farmerModel } from '../src/models/Farmer.model.js';

test('farmer lists and details use their explicit KYC link without changing payment totals', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text);
    CREATE TABLE farmers(id integer PRIMARY KEY,site_id integer,member_id integer,name text,created_by integer,created_at timestamptz);
    CREATE TABLE farmer_payments(id integer PRIMARY KEY,farmer_id integer,amount numeric,tds_amount numeric DEFAULT 0,
      interest_amount numeric DEFAULT 0,payment_mode text,cash_amount numeric,bank_amount numeric,status text,cheque_status text,date date,created_by integer);
    CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT $2='approved' AND (COALESCE($3,'CASH')<>'CHEQUE' OR $4='CLEARED') $$;
    CREATE FUNCTION ledger_bucket(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN $1='CASH' THEN 'cash' ELSE 'bank' END $$;
    INSERT INTO members VALUES(1660,8,'TIRPAL SINGH'),(1661,9,'OTHER SITE NAME'),(1662,8,'   ');
    INSERT INTO farmers VALUES(27,8,1660,'TIRPAL JI',7,now()),(28,8,NULL,'Legacy farmer',7,now()),
      (29,8,1661,'Foreign link fallback',7,now()),(30,8,1662,'Blank name fallback',7,now());
    INSERT INTO farmer_payments(id,farmer_id,amount,tds_amount,payment_mode,status,cheque_status,date,created_by) VALUES
      (1,27,100,10,'CASH','approved',NULL,'2026-10-01',7),
      (2,27,200,0,'BANK','approved',NULL,'2026-10-02',8),
      (3,27,900,0,'CASH','pending',NULL,'2026-10-03',7),
      (4,27,800,0,'CHEQUE','approved','PENDING','2026-10-04',7);
  `);
  const rows = await farmerModel.findBySiteId(8, db);
  assert.equal(rows.length, 4);
  const linked = rows.find(row => row.id === 27);
  assert.equal(linked.name, 'TIRPAL SINGH');
  assert.equal(linked.registered_name, 'TIRPAL JI');
  assert.equal(Number(linked.total_paid), 310);
  assert.equal(Number(linked.cash_paid), 100);
  assert.equal(Number(linked.bank_paid), 200);
  assert.equal(Number(linked.payment_count), 2);
  assert.equal(rows.find(row => row.id === 28).name, 'Legacy farmer');
  assert.equal(rows.find(row => row.id === 29).name, 'Foreign link fallback');
  assert.equal(rows.find(row => row.id === 30).name, 'Blank name fallback');
  const detail = await farmerModel.findByIdWithSummary(27, db);
  assert.equal(detail.name, 'TIRPAL SINGH');
  assert.equal(Number(detail.total_paid), 310);
  assert.equal((await farmerModel.findByCreator(7, db)).find(row => row.id === 27).name, 'TIRPAL SINGH');
  const ownPayments = await farmerModel.findBySiteId(8, db, '7');
  assert.equal(Number(ownPayments.find(row => row.id === 27).total_paid), 110);

  await db.query('UPDATE members SET full_name=$1 WHERE id=$2', ['TIRPAL SINGH UPDATED',1660]);
  assert.equal((await farmerModel.findByIdWithSummary(27, db)).name, 'TIRPAL SINGH UPDATED');
  assert.equal((await db.query('SELECT name FROM farmers WHERE id=27')).rows[0].name, 'TIRPAL JI');
});
