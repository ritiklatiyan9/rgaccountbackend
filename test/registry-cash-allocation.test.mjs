import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { registryCoverageSql, registryCashAllocationSql } from '../src/utils/registryCashAllocation.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
test('existing CASH covers the registry without posting money or counting linked cash twice', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE plot_registries(id int PRIMARY KEY, plot_id int, site_id int, plot_no text);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_no text);
      CREATE TABLE plot_payments(id int PRIMARY KEY, plot_id int, date date, amount numeric, payment_type text,
        payment_from text, narration text, bank_details text, cheque_no text, status text, cheque_status text);
      CREATE TABLE plot_registry_payments(id int PRIMARY KEY, registry_id int, source_plot_payment_id int,
        amount numeric, payment_mode text, payment_date date, notes text, cheque_no text, include_in_noc boolean DEFAULT true,
        status text DEFAULT 'approved', cheque_status text, created_by int);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY, source_module text, source_id int, debit numeric, credit numeric);
      INSERT INTO plots VALUES (22,5,'A22'),(23,5,'A23');
      INSERT INTO plot_registries VALUES (693,22,5,'A22');
      INSERT INTO plot_payments(id,plot_id,date,amount,payment_type,status) VALUES
        (1,22,'2026-09-01',550000,'BANK','approved'), (2,22,'2026-09-02',100000,'CASH','approved'),
        (3,23,'2026-09-01',999999,'BANK','approved');
      INSERT INTO plot_registry_payments(id,registry_id,source_plot_payment_id,amount,payment_mode) VALUES
        (1,693,1,550000,'BANK'),(2,693,2,100000,'CASH'),(3,693,NULL,50000,'CASH');
      INSERT INTO cash_flow_entries(source_module,source_id,debit,credit) VALUES
        ('plot_payments',1,0,550000),('plot_payments',2,0,100000),('plot_registry_payments',3,50000,0);
      CREATE FUNCTION test_registry_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        DELETE FROM cash_flow_entries WHERE source_module='plot_registry_payments' AND source_id=NEW.id;
        INSERT INTO cash_flow_entries(source_module,source_id,debit,credit) VALUES ('plot_registry_payments',NEW.id,NEW.amount,0);
        RETURN NEW; END; $$;
      CREATE TRIGGER trg_sync_cfe_plot_registry_payments AFTER INSERT OR UPDATE ON plot_registry_payments
        FOR EACH ROW EXECUTE FUNCTION test_registry_sync();`);
    await db.exec(read('../src/migrations/118_credit_first_posting.js').match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]+?\$\$\s*`/)[0].slice(0, -1));
    const query = (sql, params) => db.query(sql, params);
    const pool = { connect: async () => ({ query, release() {} }) };
    const migration = read('../src/migrations/161_registry_cash_allocation.js');
    const ctx = vm.createContext({ pool });
    vm.runInContext(migration.slice(migration.indexOf('export async function up'), migration.indexOf('\nif (process.argv'))
      .replace('export async function', 'async function') + '\nthis.migrate = up;', ctx);
    const sourceBefore = (await db.query('SELECT * FROM plot_payments ORDER BY id')).rows;
    const allocationBefore = (await db.query('SELECT * FROM plot_registry_payments ORDER BY id')).rows;
    await ctx.migrate(); await ctx.migrate();
    assert.deepEqual((await db.query('SELECT * FROM plot_payments ORDER BY id')).rows, sourceBefore);
    assert.deepEqual((await db.query('SELECT * FROM plot_registry_payments ORDER BY id')).rows, allocationBefore);
    const cashFlow = async () => (await db.query('SELECT SUM(debit)::float AS debit, SUM(credit)::float AS credit FROM cash_flow_entries')).rows[0];
    assert.deepEqual(await cashFlow(), { debit: 0, credit: 650000 });
    // A startup backfill must not recreate the allocation's financial mirror.
    await db.exec("INSERT INTO cash_flow_entries(source_module,source_id,debit,credit) VALUES ('plot_registry_payments',3,50000,0)");
    assert.deepEqual(await cashFlow(), { debit: 0, credit: 650000 });

    const controller = read('../src/controllers/registry.controller.js');
    const save = controller.slice(controller.indexOf('export const saveRegistryNoc'));
    const sqlAfter = (text, marker) => {
      const start = text.indexOf('`', text.indexOf(marker));
      return vm.runInNewContext(text.slice(start, text.indexOf('`', start + 1) + 1), { registryCoverageSql });
    };
    const generationSql = sqlAfter(save, 'const totalRes =');
    const approvalSql = sqlAfter(controller.slice(controller.indexOf('export const approveRegistryNoc')), 'const { rows } =');
    const snapshotSql = sqlAfter(save, 'const snapshotResult =');
    const covered = async () => Number((await db.query(generationSql, [693,22,5,'A22'])).rows[0].total_paid);
    assert.equal(await covered(), 600000);
    assert.equal(Number((await db.query(approvalSql, [693])).rows[0].total_paid), 600000);
    const snapshot = (await db.query(snapshotSql, [693])).rows[0];
    assert.equal(Number(snapshot.included_amount), 600000);
    assert.equal(snapshot.included_count, 2);
    assert.deepEqual(snapshot.payments.map(p => [p.source,Number(p.amount)]).sort(), [['cash_allocation',50000],['plot',550000]]);

    // Execute the same lateral aggregates used by both Registry list/detail.
    const modelSource = read('../src/models/PlotRegistry.model.js');
    const aggregate = modelSource.match(/SELECT\n          \$\{registryCoverageSql\}[\s\S]+?\n      \) agg/)[0].replace(/\n      \) agg$/, '');
    const aggregateSql = vm.runInNewContext('`'+aggregate+'`', { registryCoverageSql, registryCashAllocationSql });
    const totals = (await db.query(`SELECT agg.* FROM plot_registries pr LEFT JOIN LATERAL (${aggregateSql}) agg ON TRUE WHERE pr.id=$1`, [693,null])).rows[0];
    assert.equal(Number(totals.total_paid), 600000); assert.equal(totals.payment_count, 2);
    // Changes replace the allocation amount; source receipts remain intact.
    await db.exec('UPDATE plot_registry_payments SET amount=60000 WHERE id=3');
    assert.equal(await covered(), 610000);
    assert.deepEqual(await cashFlow(), { debit: 0, credit: 650000 });
    await db.exec("UPDATE plot_registry_payments SET payment_mode='BANK' WHERE id=3");
    assert.equal(Number((await db.query("SELECT debit FROM cash_flow_entries WHERE source_module='plot_registry_payments' AND source_id=3")).rows[0].debit), 60000);
    await db.exec("UPDATE plot_registry_payments SET payment_mode='CASH' WHERE id=3");
    assert.deepEqual(await cashFlow(), { debit: 0, credit: 650000 });
    // Rejected allocations cannot clear a registry; a foreign plot cannot either.
    await db.exec("UPDATE plot_registry_payments SET status='rejected' WHERE id=3; INSERT INTO plot_registry_payments(id,registry_id,source_plot_payment_id,amount,payment_mode) VALUES(4,693,3,999999,'BANK')");
    assert.equal(await covered(), 650000);
    await db.exec('DELETE FROM plot_registry_payments WHERE id=3');
    assert.equal(await covered(), 650000);
    assert.deepEqual((await db.query('SELECT * FROM plot_payments ORDER BY id')).rows, sourceBefore);
  } finally { await db.close(); }
});
