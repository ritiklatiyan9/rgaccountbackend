/**
 * Inventory lot-expiry check — run: npm run check:inventory-expiry
 *
 * Asserts the FIFO lot math the Stock tab and the Construction & Vendors
 * overview depend on: stock-out consumes the OLDEST lot first, so a lot's
 * expiry only counts while that lot still has quantity left. Runs inside one
 * transaction and always rolls back — nothing is written.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import pool from '../config/db.js';
import { inventoryModel } from '../models/Inventory.model.js';

const day = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA');
};
const num = (v) => Number(v) || 0;
// pg hands DATE columns back as local-midnight Date objects.
const ymd = (v) => (v instanceof Date ? v.toLocaleDateString('en-CA') : String(v).slice(0, 10));

const client = await pool.connect();
try {
  await client.query('BEGIN');
  const { rows: [site] } = await client.query('SELECT id FROM sites ORDER BY id LIMIT 1');
  assert.ok(site, 'need at least one site');
  const { rows: [mat] } = await client.query(
    `INSERT INTO inventory_materials (site_id, name, unit, rate) VALUES ($1, '__LOT_CHECK__', 'BAG', 10) RETURNING id`, [site.id]);
  const mv = (movement_type, qty, expiry_date = null) => inventoryModel.insertMovement(
    { site_id: site.id, material_id: mat.id, movement_type, qty, rate: 10, expiry_date }, client);

  // Lot A (oldest, expires in 5d) 100, lot B (expires in 60d) 50, then issue 120.
  await mv('RECEIPT', 100, day(5));
  await mv('RECEIPT', 50, day(60));
  await mv('ISSUE', 120);

  let [m] = await inventoryModel.listMaterials(site.id, { search: '__LOT_CHECK__' }, client);
  assert.equal(num(m.on_hand), 30, 'on hand = 150 - 120');
  assert.equal(ymd(m.next_expiry), day(60), 'lot A fully consumed → next expiry is lot B');
  assert.equal(num(m.expiring_qty), 0, 'lot B is outside the 30-day window');
  let lots = await inventoryModel.expiringLots(site.id, { days: 30 }, client);
  assert.equal(lots.filter((l) => l.material_id === mat.id).length, 0, 'nothing expiring within 30 days');

  // Lot C arrives already expired (yesterday) → it is the newest lot, so it is untouched by the earlier issue.
  await mv('RECEIPT', 20, day(-1));
  [m] = await inventoryModel.listMaterials(site.id, { search: '__LOT_CHECK__' }, client);
  assert.equal(num(m.on_hand), 50);
  assert.equal(ymd(m.next_expiry), day(-1), 'expired lot is the earliest live expiry');
  assert.equal(num(m.expired_qty), 20);
  assert.equal(num(m.expiring_qty), 20, 'expired lots count as expiring');
  lots = (await inventoryModel.expiringLots(site.id, { days: 30 }, client)).filter((l) => l.material_id === mat.id);
  assert.equal(lots.length, 1);
  assert.equal(num(lots[0].qty_remaining), 20);
  assert.equal(lots[0].days_left, -1);

  const flagged = await inventoryModel.listMaterials(site.id, { expiring: true }, client);
  assert.ok(flagged.some((x) => x.id === mat.id), 'expiring filter returns the material');

  const summary = await inventoryModel.summary(site.id, client);
  assert.ok(summary.expiring_count >= 1 && summary.expired_count >= 1, 'summary counts the material');

  // Consuming the rest drains lot B (older) before lot C (newer): C keeps its 20 until B is gone.
  await mv('CONSUMPTION', 30);
  [m] = await inventoryModel.listMaterials(site.id, { search: '__LOT_CHECK__' }, client);
  assert.equal(num(m.on_hand), 20);
  assert.equal(num(m.expired_qty), 20, 'FIFO: lot C untouched while older lot B absorbed the consumption');
  await mv('CONSUMPTION', 20);
  [m] = await inventoryModel.listMaterials(site.id, { search: '__LOT_CHECK__' }, client);
  assert.equal(num(m.on_hand), 0);
  assert.equal(m.next_expiry, null, 'no live lot → no expiry');

  console.log('✅ inventory lot-expiry check passed (site', site.id + ')');
} finally {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
