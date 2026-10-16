import test from 'node:test';
import assert from 'node:assert/strict';
import { plotDiscountForWrite } from '../src/services/plotDiscount.service.js';
import { migrationSql, up } from '../src/migrations/214_plot_fixed_discount.js';
import { plotSnapshotFunctionSql } from '../src/migrations/172_approval_change_snapshots.js';
import { plotModel } from '../src/models/Plot.model.js';

test('API accepts exact rupees, clears the other discount and leaves metadata-only edits alone', () => {
  assert.deepEqual(plotDiscountForWrite({ discount_amount: '12345.67' }), { discount_amount: 12345.67, discount_rate: 0 });
  assert.deepEqual(plotDiscountForWrite({ discount_rate: '100' }), { discount_rate: 100, discount_amount: 0 });
  assert.deepEqual(plotDiscountForWrite({ discount_rate: '0' }), { discount_rate: 0, discount_amount: 0 });
  assert.deepEqual(plotDiscountForWrite({ discount_amount: '' }), { discount_amount: 0 });
  assert.deepEqual(plotDiscountForWrite({ notes: 'Updated' }), {});
  for (const body of [{ discount_amount: -1 }, { discount_amount: 'bad' }, { discount_amount: Infinity }, { discount_rate: -1 }, { discount_rate: 100, discount_amount: 10000 }]) {
    assert.throws(() => plotDiscountForWrite(body), { statusCode: 400 });
  }
});

test('migration preserves historic prices and exact discounts survive model writes and approval snapshots', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_size numeric(14,4),
        plot_rate numeric(15,2), original_plot_rate numeric(15,2), discount_rate numeric(15,2),
        sale_price numeric(15,2), notes text, approval_status text, updated_at timestamptz,
        approval_original_data jsonb, approval_proposed_data jsonb);
      INSERT INTO plots VALUES(1,5,205.51,18900,19000,100,3884139,'Historic','approved',NOW(),NULL,NULL);
    `);
    const before = (await db.query('SELECT * FROM plots')).rows[0];
    const database = { connect: async () => ({
      query: async (sql, values) => sql === migrationSql ? (await db.exec(sql), { rows: [] }) : db.query(sql, values),
      release() {},
    }) };
    assert.equal(await up(database), true);
    assert.equal(await up(database), false);
    const { discount_amount, ...after } = (await db.query('SELECT * FROM plots')).rows[0];
    assert.equal(Number(discount_amount), 0);
    assert.deepEqual(after, before, 'installation does not change prices or approval history');
    await db.exec(`${plotSnapshotFunctionSql};
      CREATE TRIGGER trg_approval_change_snapshot BEFORE UPDATE ON plots
      FOR EACH ROW EXECUTE FUNCTION capture_plot_approval_change();`);
    const saved = await plotModel.update(1, {
      ...plotDiscountForWrite({ discount_amount: '12345.67' }),
      sale_price: 3892344.33, plot_rate: 18939.93, approval_status: 'pending',
    }, db);
    assert.equal(Number(saved.discount_amount), 12345.67);
    assert.equal(Number(saved.sale_price), 3892344.33);
    assert.equal(Number(saved.discount_rate), 0);
    assert.equal(Number(saved.approval_original_data.discount_amount), 0);
    assert.equal(Number(saved.approval_proposed_data.discount_amount), 12345.67);
    const metadata = await plotModel.update(1, { notes: 'Updated' }, db);
    assert.equal(Number(metadata.discount_amount), 12345.67);
    assert.equal(Number(metadata.sale_price), 3892344.33);
    const replaced = await plotModel.update(1, { ...plotDiscountForWrite({ discount_rate: 100 }), sale_price: 3884139, plot_rate: 18900 }, db);
    assert.equal(Number(replaced.discount_amount), 0);
    assert.equal(Number(replaced.discount_rate), 100);
    await assert.rejects(db.query('UPDATE plots SET discount_amount=-1 WHERE id=1'), /check constraint/);
  } finally { await db.close(); }
});
