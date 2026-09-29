import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('editing a farmer saves its chosen status without payment-only columns', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE farmers (
      id integer PRIMARY KEY, name text, total_amount numeric, status text,
      payment_mode text, cash_amount numeric, bank_amount numeric,
      land_rate numeric, commission_percentage numeric
    );
    INSERT INTO farmers VALUES (28, 'Original Farmer', 100, 'active', 'CASH', 100, 0);`);

    const source = readFileSync(new URL('../src/controllers/farmer.controller.js', import.meta.url), 'utf8');
    const start = source.indexOf('export const updateFarmer =');
    const end = source.indexOf('/**\n * DELETE /farmers/:id', start);
    assert.ok(start >= 0 && end > start);
    const handlerSource = source.slice(start, end).replace('export const updateFarmer =', 'const updateFarmer =');
    const farmerModel = {
      async update(id, data) {
        const keys = Object.keys(data);
        const result = await db.query(
          `UPDATE farmers SET ${keys.map((key, index) => `${key} = $${index + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
          [...Object.values(data), id]
        );
        return result.rows[0];
      },
    };
    const context = vm.createContext({ farmerModel, pool: {}, asyncHandler: fn => fn });
    vm.runInContext(`${handlerSource}\nthis.handler = updateFarmer;`, context);

    let status = 200;
    let body;
    await context.handler({ params: { id: '28' }, body: {
      name: 'Edited Farmer', status: 'completed', payment_mode: 'SPLIT',
      total_amount: 150, cash_amount: 100, bank_amount: 50,
    } }, {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
    });

    assert.equal(status, 200);
    assert.equal(body.farmer.name, 'Edited Farmer');
    assert.equal(body.farmer.status, 'completed');
    assert.equal(Number(body.farmer.total_amount), 150);
    assert.equal(body.farmer.payment_mode, 'SPLIT');

    const editRequestSource = readFileSync(new URL('../src/controllers/editRequest.controller.js', import.meta.url), 'utf8');
    const requestStart = editRequestSource.indexOf('  farmer: {');
    const requestEnd = editRequestSource.indexOf('  farmer_payment: {', requestStart);
    assert.ok(requestStart >= 0 && requestEnd > requestStart);
    const requestContext = vm.createContext({ farmerModel, pool: {} });
    vm.runInContext(`this.farmerRequest = ({${editRequestSource.slice(requestStart, requestEnd)}}).farmer;`, requestContext);
    const approved = await requestContext.farmerRequest.applyUpdate('28', {
      status: 'inactive', payment_mode: 'BANK', cash_amount: 0, bank_amount: 220,
      total_amount: 220, land_rate: 500, commission_percentage: 2.5,
    });
    assert.equal(approved.status, 'inactive');
    assert.equal(approved.payment_mode, 'BANK');
    assert.equal(Number(approved.land_rate), 500);
    assert.equal(Number(approved.commission_percentage), 2.5);
  } finally {
    await db.close();
  }
});
