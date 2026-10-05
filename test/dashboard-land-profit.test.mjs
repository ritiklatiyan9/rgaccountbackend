import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getLandProfitDetail } from '../src/graphql/services/kpi.service.js';

// Exercise the dashboard's SQL against an isolated PostgreSQL engine. No
// customer connection is opened and no application records are changed.
test('dashboard Land Profit uses prices of sold portions only', async (t) => {
  const db = new PGlite();
  const originalQuery = pool.query;
  pool.query = (sql, values) => db.query(sql, values);
  try {
    await db.exec(`
      CREATE TABLE farmers(id integer PRIMARY KEY, site_id integer, total_amount numeric);
      CREATE TABLE land_deals(id integer PRIMARY KEY, farmer_id integer, site_id integer,
        sale_amount numeric, purchase_cost numeric, other_cost numeric, deal_date date, status text);
      CREATE TABLE land_deal_payments(id integer PRIMARY KEY, land_deal_id integer);
      CREATE TABLE farmer_payments(id integer PRIMARY KEY, farmer_id integer);
      CREATE TABLE ledger_entries(site_id integer, entry_date date, source_key text, source_id integer,
        credit numeric DEFAULT 0, debit numeric DEFAULT 0, bucket text);
      INSERT INTO farmers VALUES (1,1,1000000),(2,1,5000000),(3,2,9000000);
      INSERT INTO farmer_payments VALUES (1,1),(2,2);
      INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,debit,bucket) VALUES
        (1,'2026-01-01','farmer_payments',1,700000,'cash'),
        (1,'2026-01-01','farmer_payments',2,5000000,'bank');
    `);

    await t.test('unsold purchases produce zero even when farmers are paid', async () => {
      const land = await getLandProfitDetail(1, '2026-10-06');
      assert.equal(land.saleProfit, 0);
      assert.equal(land.purchaseCost, 0);
      assert.equal(land.dealCount, 0);
    });

    await db.exec(`
      INSERT INTO land_deals VALUES
        (1,1,1,350000,200000,5000,'2026-02-01','open'),
        (2,1,1,100000,150000,1000,'2026-03-01','completed'),
        (3,1,1,9000000,100000,0,'2026-03-01','cancelled'),
        (4,1,1,8000000,100000,0,'2026-10-06','open'),
        (5,3,2,7000000,100000,0,'2026-02-01','open'),
        (6,2,1,10000000,5000000,0,'2026-02-01','purchased');
    `);

    await t.test('partial sales use allocated purchase costs, including losses', async () => {
      const land = await getLandProfitDetail(1, '2026-10-06');
      assert.equal(land.saleValue, 450000);
      assert.equal(land.purchaseCost, 350000);
      assert.equal(land.saleProfit, 100000);
      assert.equal(land.dealCount, 2);
      assert.equal(land.received, 0, 'a recorded sale counts before collection');
      assert.equal(land.bookProfit, 94000, 'other costs belong to the separate book-profit calculation');
    });

    await t.test('buyer receipts and farmer payments do not change sale-price profit', async () => {
      await db.exec(`
        INSERT INTO land_deal_payments VALUES (1,1);
        INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,credit,bucket)
          VALUES (1,'2026-04-01','land_deal_payments',1,25000,'cash');
      `);
      const land = await getLandProfitDetail(1, '2026-10-06');
      assert.equal(land.received, 25000);
      assert.equal(land.paidToFarmers, 5700000);
      assert.equal(land.saleProfit, 100000);
    });

    await t.test('selling below purchase price shows a loss', async () => {
      await db.exec("UPDATE land_deals SET status = 'cancelled' WHERE id = 1");
      const land = await getLandProfitDetail(1, '2026-10-06');
      assert.equal(land.saleValue, 100000);
      assert.equal(land.purchaseCost, 150000);
      assert.equal(land.saleProfit, -50000);
    });

    await t.test('equal purchase and sale prices show break-even', async () => {
      await db.exec('UPDATE land_deals SET sale_amount = purchase_cost WHERE id = 2');
      const land = await getLandProfitDetail(1, '2026-10-06');
      assert.equal(land.saleProfit, 0);
    });
  } finally {
    pool.query = originalQuery;
    await db.close();
  }
});
