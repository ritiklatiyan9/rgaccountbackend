// An isolated schema for the chart's bounds and posted ledger aggregation.
// No application credentials, production migrations, or customer data.
export async function createDashboardChartFixture(db, count = 0) {
  await db.exec(`
    CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_tag text);
    CREATE TABLE farmers(id int PRIMARY KEY, site_id int);
    CREATE TABLE land_deals(id int PRIMARY KEY, site_id int, status text);
    CREATE TABLE plot_payments(id int, site_id int, plot_id int, date date);
    CREATE TABLE plot_installment_payments(id int, plot_id int, payment_date date);
    CREATE TABLE land_deal_payments(id int, land_deal_id int, date date);
    CREATE TABLE farmer_payments(id int, farmer_id int, date date);
    CREATE TABLE expenses(id int, site_id int, date date);
    CREATE TABLE plot_commission_payments(id int, site_id int, date date);
    CREATE TABLE vendor_payments(id int, site_id int, payment_date date);
    CREATE TABLE vendor_inventory_payments(id int, site_id int, payment_date date, source_vendor_payment_id int);
    CREATE TABLE ledger_entries(id int, site_id int, entry_date date, source_key text, source_id int,
      debit numeric, credit numeric, plot_tag text, ledger_type text);
    CREATE TABLE tds_settlements(existing_entry_id int);
    CREATE TABLE tds_accounting_deductions(id int, site_id int, deduction_date date, source_table text,
      source_id int, commission_payment_id int, tds_amount numeric, gross_amount numeric, accounting_state text);
  `);
  if (count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid fixture count');
    await db.exec(`
      INSERT INTO plots SELECT n,1+n%3,CASE WHEN n%7=0 THEN 'OLD' ELSE '' END FROM generate_series(1,${count}) n;
      INSERT INTO farmers SELECT n,1+n%3 FROM generate_series(1,${count}) n;
      INSERT INTO land_deals SELECT n,1+n%3,'open' FROM generate_series(1,${count}) n;
      INSERT INTO plot_payments SELECT n,1+n%3,n,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO plot_installment_payments SELECT n,n,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO land_deal_payments SELECT n,n,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO farmer_payments SELECT n,n,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO expenses SELECT n,1+n%3,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO plot_commission_payments SELECT n,1+n%3,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO vendor_payments SELECT n,1+n%3,DATE '2021-01-01'+n%2000 FROM generate_series(1,${count}) n;
      INSERT INTO vendor_inventory_payments SELECT n,1+n%3,DATE '2021-01-01'+n%2000,
        CASE WHEN n%13=0 THEN n END FROM generate_series(1,${count}) n;
      INSERT INTO ledger_entries SELECT n,1+n%3,DATE '2021-01-01'+n%2000,
        CASE WHEN n%2=0 THEN 'plot_payments' ELSE 'expenses' END,n,
        CASE WHEN n%2=1 THEN 75.15 ELSE 0 END,CASE WHEN n%2=0 THEN 125.35 ELSE 0 END,'','site'
        FROM generate_series(1,${count}) n;
    `);
  }
  // Use representative existing index shapes; this change adds no indexes.
  await db.exec(`
    CREATE INDEX ON plot_payments(site_id,date);
    CREATE INDEX ON plot_installment_payments(plot_id,payment_date);
    CREATE INDEX ON land_deal_payments(land_deal_id,date);
    CREATE INDEX ON farmer_payments(farmer_id,date);
    CREATE INDEX ON expenses(site_id,date);
    CREATE INDEX ON plot_commission_payments(site_id,date);
    CREATE INDEX ON vendor_payments(site_id,payment_date);
    CREATE INDEX ON vendor_inventory_payments(site_id,payment_date);
    ANALYZE;
  `);
}
