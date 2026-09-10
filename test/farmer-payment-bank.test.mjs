import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFarmerPaymentBank } from '../src/services/farmerPaymentBank.service.js';

test('older edit requests leave bank mappings untouched', async () => {
  await applyFarmerPaymentBank({ query() { throw new Error('Unexpected database write'); } }, {}, {});
});

test('approved land payment edits map, clear, and reject unavailable or foreign banks atomically', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE farmers(id int, site_id int);
      CREATE TABLE bank_accounts(id int, site_id int, is_active boolean);
      CREATE TABLE farmer_payments(id int, farmer_id int, payment_mode text);
      CREATE TABLE cash_flow_entries(id int, site_id int, source_module text, source_id int, bank_account_id int, updated_at timestamptz);
      INSERT INTO farmers VALUES(1, 10);
      INSERT INTO bank_accounts VALUES(5,10,true),(6,20,true),(7,10,false);
      INSERT INTO farmer_payments VALUES(1,1,'BANK');
      INSERT INTO cash_flow_entries VALUES(1,10,'farmer_payments',1,NULL,NULL);`);
    const payment = { id: 1, farmer_id: 1, payment_mode: 'BANK' };
    const mapping = async () => (await db.query('SELECT bank_account_id FROM cash_flow_entries WHERE id=1')).rows[0].bank_account_id;
    await applyFarmerPaymentBank(db, payment, { bank_account_id: 5 });
    assert.equal(await mapping(), 5);
    for (const value of [6, 7, '', null, '5oops', -1, 5.5]) {
      await assert.rejects(applyFarmerPaymentBank(db, payment, { bank_account_id: value }), { code: 'INVALID_PAYMENT_BANK' });
      assert.equal(await mapping(), 5);
    }
    await applyFarmerPaymentBank(db, { ...payment, payment_mode: 'CASH' }, { bank_account_id: null });
    assert.equal(await mapping(), null);
    await applyFarmerPaymentBank(db, { ...payment, payment_mode: 'CHEQUE' }, { bank_account_id: 5 });
    assert.equal(await mapping(), 5);
    await db.exec('BEGIN');
    await db.exec("UPDATE farmer_payments SET payment_mode='CHEQUE' WHERE id=1");
    await assert.rejects(applyFarmerPaymentBank(db, payment, { bank_account_id: 6 }));
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT payment_mode FROM farmer_payments WHERE id=1')).rows[0].payment_mode, 'BANK');
    assert.equal(await mapping(), 5);
  } finally { await db.close(); }
});
