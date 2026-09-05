import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('KYC mapping requires plot update permission and access to the owning site', () => {
  const routes = readFileSync(new URL('../src/routes/plot.routes.js', import.meta.url), 'utf8');
  assert.match(routes, /router\.put\('\/:id\/kyc-member', requireRole\('admin', 'sub_admin'\), requirePermission\('plot_payments', 'update'\), accessByParamPlot, bustPlotCache, linkPlotBuyer\)/);
  assert.match(routes, /router\.get\('\/kyc-members', requireRole\('admin', 'sub_admin'\), requirePermission\('plot_payments', 'read'\), accessByQuerySite, listPlotKycMembers\)/);
});

test('mapping changes only the selected plot identity and rejects foreign-site users', {
  skip: process.env.PLOT_MEMBER_LINK_DB_TEST !== '1' && 'Set PLOT_MEMBER_LINK_DB_TEST=1 for isolated PostgreSQL verification',
}, async () => {
  const { default: pool } = await import('../src/config/db.js');
  const { linkPlotBuyer } = await import('../src/controllers/plot.controller.js');
  const client = await pool.connect();
  const originalQuery = pool.query;
  const invoke = (plotId, memberId) => new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); } };
    linkPlotBuyer({ params: { id: String(plotId) }, body: { buyer_member_id: memberId } }, res, reject);
  });
  try {
    await client.query('BEGIN');
    // Session-local tables shadow public tables. No real account rows are edited.
    await client.query(`CREATE TEMP TABLE members (id integer PRIMARY KEY, site_id integer) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE plots (id integer PRIMARY KEY, site_id integer,
      buyer_member_id integer REFERENCES members(id), buyer_name text, status text, sale_price numeric,
      booking_by text, booking_date date, updated_at timestamptz) ON COMMIT DROP`);
    await client.query('INSERT INTO members VALUES (1,10), (2,10), (3,20)');
    await client.query(`INSERT INTO plots VALUES (420,10,NULL,'REENA','REGISTRY',100000,'AGENT','2026-01-01',NULL),
      (421,10,NULL,'REENA','BOOKED',200000,'AGENT','2026-02-01',NULL)`);
    pool.query = client.query.bind(client);
    const before = (await client.query('SELECT * FROM plots WHERE id = 420')).rows[0];
    const saved = await invoke(420, 2);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.plot.buyer_member_id, 2);
    const after = (await client.query('SELECT * FROM plots WHERE id = 420')).rows[0];
    const { buyer_member_id: _oldId, updated_at: _oldTime, ...oldFields } = before;
    const { buyer_member_id: _newId, updated_at: _newTime, ...newFields } = after;
    assert.deepEqual(newFields, oldFields, 'identity mapping must preserve buyer text, status, price and booking');
    assert.equal((await client.query('SELECT buyer_member_id FROM plots WHERE id = 421')).rows[0].buyer_member_id, null);
    await assert.rejects(invoke(420, 3), { statusCode: 400 });
    await assert.rejects(invoke(420, null), { statusCode: 400 });
    assert.equal((await client.query('SELECT buyer_member_id FROM plots WHERE id = 420')).rows[0].buyer_member_id, 2);
    assert.equal((await invoke(999, 1)).status, 404);
  } finally {
    pool.query = originalQuery;
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
});
