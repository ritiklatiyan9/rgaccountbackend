import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { getProjectPaymentSettings, updateProjectPaymentSettings } from '../src/controllers/applicationSetting.controller.js';
import requireRole from '../src/middlewares/role.middleware.js';
import { readPlotPaymentHistory } from '../src/services/plotPaymentHistory.service.js';

const invoke = (handler, req) => new Promise((resolve, reject) => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
  handler(req, res, reject);
});

test('project payment defaults round-trip per site and record the changing user', async t => {
  const stored = new Map();
  const writes = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    if (sql.includes('SELECT id FROM sites')) return { rows: [{ id: params[0] }] };
    if (sql.includes('SELECT setting_value')) return { rows: stored.has(params[0]) ? [{ setting_value: stored.get(params[0]) }] : [] };
    if (sql.includes('INSERT INTO application_settings')) {
      writes.push(params); stored.set(params[0], JSON.parse(params[2]));
      return { rows: [{ setting_value: stored.get(params[0]) }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const user = { id: 8, role: 'admin' };
  const read = site => invoke(getProjectPaymentSettings, { user, query: { site_id: site } });
  assert.equal((await read(1)).body.default_view, 'combined');
  for (const value of ['old', 'new', 'combined']) {
    const result = await invoke(updateProjectPaymentSettings, { user, body: { site_id: 1, default_view: value } });
    assert.equal(result.status, 200);
    assert.equal((await read(1)).body.default_view, value);
    assert.equal((await read(2)).body.default_view, 'combined');
  }
  assert.ok(writes.every(params => params[1] === 'project_payments_default_view' && params[3] === 8));
  const bad = await invoke(updateProjectPaymentSettings, { user, body: { site_id: 1, default_view: 'all' } });
  assert.equal(bad.status, 400);
  assert.equal(writes.length, 3);
});

test('unassigned users cannot read defaults and ordinary users cannot change them', async t => {
  t.mock.method(pool, 'query', async sql => ({ rows: sql.includes('SELECT id FROM sites') ? [{ id: 1 }] : [] }));
  const user = { id: 9, role: 'sub_admin' };
  assert.equal((await invoke(getProjectPaymentSettings, { user, query: { site_id: 1 } })).status, 403);
  assert.equal((await invoke(requireRole('admin'), { user })).status, 403);
  assert.equal((await invoke(getProjectPaymentSettings, { user, query: {} })).status, 400);
});

test('related history keeps site, physical unit and creator restrictions in the SQL', async () => {
  let captured;
  const result = await readPlotPaymentHistory({ query: async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 42 }] }; } }, 34, '5,8');
  assert.deepEqual(result, [{ id: 42 }]);
  assert.deepEqual(captured.params, [34, '5,8']);
  for (const fragment of ['p.site_id = anchor.site_id', 'pp.site_id = p.site_id', 'BTRIM(p.plot_no)', "BTRIM(COALESCE(p.block, ''))", "'unit_type'", "'tower'", "'floor'", 'anchor.id = $1', "string_to_array($2::text, ',')::int[]"]) assert.ok(captured.sql.includes(fragment), fragment);
  assert.doesNotMatch(captured.sql, /ILIKE|LIKE\s/i);
});
