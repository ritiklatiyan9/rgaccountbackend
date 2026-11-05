import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { daybookMirrorDateSql } from '../src/services/daybookDate.service.js';
import { attachTransactionParticulars } from '../src/services/transactionParticulars.service.js';

test('daily Day Book includes pool receipts once, respecting site, creator and cleared cheque dates', async () => {
  const controller = readFileSync(new URL('../src/controllers/daybook.controller.js', import.meta.url), 'utf8');
  const template = controller.match(/`(SELECT cfe\.\*, u\.name AS assigned_admin_name,[\s\S]*?)`/)[1];
  const sql = template.replace("${daybookMirrorDateSql('cfe')}", daybookMirrorDateSql('cfe'));
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id int, name text);
      CREATE TABLE plots(id int, plot_no text);
      CREATE TABLE plot_commissions_v2(id int, plot_id int);
      CREATE TABLE plot_commission_payments(id int, plot_commission_id int);
      CREATE TABLE cash_flow_entries(id int, source_module text, source_id int, site_id int,
        date date, created_by int, assigned_admin_id int, cash_type text, cheque_status text,
        cheque_transaction_date date, status text, credit numeric, debit numeric);
      INSERT INTO cash_flow_entries VALUES
        (1,'pool_money_receipts',1,7,'2026-11-05',10,10,'cash',NULL,NULL,'approved',10000,0),
        (2,'pool_money_receipts',2,7,'2026-11-05',11,10,'bank',NULL,NULL,'pending',5000,0),
        (3,'pool_money_receipts',3,8,'2026-11-05',10,10,'cash',NULL,NULL,'approved',90000,0),
        (4,'pool_money_receipts',4,7,'2026-11-01',10,10,'cheque','CLEARED','2026-11-05','approved',20000,0),
        (5,'pool_money_receipts',5,7,'2026-11-05',10,10,'cheque','PENDING',NULL,'approved',30000,0),
        (6,'pool_money_receipts',6,7,'2026-11-05',10,10,'cash',NULL,NULL,'rejected',1000,0),
        (7,'plot_payments',7,7,'2026-11-05',10,10,'cash',NULL,NULL,'approved',7000,0);
      CREATE TABLE pool_money_receipts(id int, buyer_name text);
      INSERT INTO pool_money_receipts VALUES(1,'Applicant One');`);
    const rows = (await db.query(sql, [7, '2026-11-05', null])).rows;
    assert.deepEqual(rows.map(row => row.id).sort(), [1, 2, 4]);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.credit), 0), 35000);
    assert.deepEqual((await db.query(sql, [7, '2026-11-05', '10'])).rows.map(row => row.id).sort(), [1, 4]);
    assert.equal((await db.query(sql, [7, '2026-11-01', null])).rows.length, 0, 'cheques use clearing date');
    const entries = [{ source_key: 'pool_money_receipts', source_id: 1, credit: '10000', particular: 'Original narration' }];
    await attachTransactionParticulars(entries, db);
    assert.equal(entries[0].party_name, 'Applicant One');
    assert.equal(entries[0].category, 'Booking token');
    assert.equal(entries[0].credit, '10000');
    await db.exec("UPDATE cash_flow_entries SET source_module='plot_payments',source_id=8 WHERE id=1");
    assert.deepEqual((await db.query(sql, [7, '2026-11-05', null])).rows.map(row => row.id).sort(), [2, 4], 'allotted receipts leave pool projection and use the existing plot payment path');
  } finally { await db.close(); }
});
