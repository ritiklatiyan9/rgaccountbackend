import assert from 'node:assert/strict';
import test from 'node:test';
import { up } from '../src/migrations/215_cheque_transaction_dates.js';
import { attachChequeDates } from '../src/services/chequeDates.service.js';
import { updateChequeStatusRecord } from '../src/services/chequeStatus.service.js';

test('embedded PostgreSQL: clearance preserves application date, survives mirror upserts, and resets on reopening', {
  skip: !process.env.PGLITE_MODULE,
}, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const embedded = new PGlite();
  const db = { async query(sql, params) {
    const result = params?.length ? await embedded.query(sql, params) : (await embedded.exec(sql)).at(-1);
    return { ...result, rows: result.rows || [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
  }, release() {} };
  try {
    await db.query(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE cash_flow_entries (
        id serial PRIMARY KEY, site_id int, date date, source_module text, source_id int,
        status text, cheque_status text, cheque_no text, credit numeric, debit numeric,
        cash_flow_month_id int, updated_at timestamptz,
        UNIQUE(source_module, source_id)
      );
      CREATE TABLE plot_payments (
        id int PRIMARY KEY, site_id int, date date, amount numeric,
        status text, cheque_status text, cheque_no text, updated_at timestamptz
      );
      CREATE TABLE bank_statement_transactions(id int PRIMARY KEY, transaction_date date, value_date date);
      CREATE TABLE bank_reconciliation_links (
        site_id int, candidate_source text, candidate_entry_id int, resulting_status text,
        bank_transaction_id int, bank_value_date date
      );
      INSERT INTO plot_payments VALUES (1,8,'2026-08-10',250,'pending','PENDING','000001',now());
      INSERT INTO cash_flow_entries(id,site_id,date,source_module,source_id,status,cheque_status,credit,debit)
        VALUES (10,8,'2026-08-10','plot_payments',1,'pending','PENDING',250,0),
               (20,8,'2026-07-10','plot_payments',2,'approved','CLEARED',500,0),
               (30,8,'2026-07-11','plot_payments',3,'approved','CLEARED',600,0),
               (40,8,'2026-07-12',NULL,NULL,'approved','CLEARED',700,0);
      INSERT INTO bank_statement_transactions VALUES (5,'2026-07-20','2026-07-21');
      INSERT INTO bank_reconciliation_links VALUES (8,'plot_payment',2,'CLEARED',5,'2026-07-21');
    `);
    const adapter = { connect: async () => db };
    assert.equal(await up(adapter), true);
    assert.equal(await up(adapter), false, 'migration is idempotent');
    const row = async (id = 10) => (await db.query("SELECT *, TO_CHAR(date, 'YYYY-MM-DD') AS date, TO_CHAR(cheque_transaction_date, 'YYYY-MM-DD') AS cheque_transaction_date FROM cash_flow_entries WHERE id=$1", [id])).rows[0];
    assert.equal((await row(20)).cheque_transaction_date, '2026-07-20', 'bank transaction date takes priority over value date');
    assert.equal((await row(30)).cheque_transaction_date, null, 'unknown historical dates stay unknown');

    // Native mirrors use this upsert form: the new metadata is omitted from
    // the SET list so an approval or narration edit must preserve clearance.
    await db.query(`CREATE FUNCTION sync_test_plot_payment() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO cash_flow_entries(site_id,date,source_module,source_id,status,cheque_status,credit,debit)
        VALUES(NEW.site_id,NEW.date,'plot_payments',NEW.id,NEW.status,NEW.cheque_status,NEW.amount,0)
        ON CONFLICT(source_module,source_id) DO UPDATE SET date=EXCLUDED.date,status=EXCLUDED.status,
          cheque_status=EXCLUDED.cheque_status,credit=EXCLUDED.credit;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER sync_test_plot AFTER UPDATE ON plot_payments FOR EACH ROW EXECUTE FUNCTION sync_test_plot_payment();`);

    const cleared = await updateChequeStatusRecord(db, {
      source: 'plot_payment', entryId: 1, status: 'CLEARED', chequeTransactionDate: '2026-08-22', expectedSiteId: 8, expectedAmount: 250,
    });
    assert.equal(cleared.after.cheque_apply_date, '2026-08-10');
    assert.equal(cleared.after.cheque_transaction_date, '2026-08-22');
    assert.equal((await row()).date, '2026-08-10');
    assert.equal((await row()).cheque_transaction_date, '2026-08-22');
    await db.query("UPDATE plot_payments SET status='approved' WHERE id=1");
    assert.equal((await row()).cheque_transaction_date, '2026-08-22', 'source approval preserves clearance metadata');
    const views = [
      { date: '2026-08-10', cheque_status: 'CLEARED' },
      { entry_date: '2026-08-10', cheque_status: 'CLEARED' },
    ];
    await attachChequeDates(views, db, (_entry) => ({ ledgerId: 10, siteId: 8 }));
    assert.equal(views[0].cheque_transaction_date, '2026-08-22');
    assert.equal(views[1].cheque_apply_date, '2026-08-10');

    await db.query("UPDATE plot_payments SET cheque_status='PENDING' WHERE id=1");
    assert.equal((await row()).cheque_transaction_date, null, 'ordinary source edits invalidate the old clearance');
    await updateChequeStatusRecord(db, { source: 'plot_payment', entryId: 1, status: 'CLEARED', chequeTransactionDate: '2026-08-26' });
    await updateChequeStatusRecord(db, { source: 'plot_payment', entryId: 1, status: 'BOUNCED' });
    assert.equal((await row()).cheque_transaction_date, null);
    assert.equal((await row()).credit, '250');
    assert.equal((await row()).date, '2026-08-10');

    await updateChequeStatusRecord(db, { source: 'cash_flow_entry', entryId: 40, status: 'CLEARED' });
    assert.equal((await row(40)).cheque_transaction_date, null, 're-saving a historical cleared record does not invent a date');
    await updateChequeStatusRecord(db, { source: 'cash_flow_entry', entryId: 40, status: 'CLEARED', chequeTransactionDate: '2026-07-23' });
    assert.equal((await row(40)).cheque_transaction_date, '2026-07-23');
    await updateChequeStatusRecord(db, { source: 'cash_flow_entry', entryId: 40, status: 'PENDING' });
    assert.equal((await row(40)).cheque_transaction_date, null);
  } finally { await embedded.close(); }
});
