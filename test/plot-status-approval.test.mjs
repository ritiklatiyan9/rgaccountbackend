import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validatePlotApprover } from '../src/services/plotApproval.service.js';
import { requireApprovalAccess } from '../src/middlewares/permission.middleware.js';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('approval access preserves workspace grants and scopes other sub-admins to assignments', async () => {
  for (const canRead of [true, false, undefined]) {
    const req = { user: { id: 2, role: 'sub_admin', permissionsByModule: new Map([
      ['expense_approval', canRead === undefined ? null : { can_read: canRead }],
    ]) } };
    let passed = false;
    await requireApprovalAccess(req, {}, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(req.assignedApprovalsOnly, canRead !== true);
  }
  let status;
  await requireApprovalAccess({ user: { id: 4, role: 'viewer' } }, {
    status(value) { status = value; return this; }, json() {},
  }, () => assert.fail('an unrelated role must not get approval access'));
  assert.equal(status, 403);
});

test('requires an active reviewer in the site scope', async () => {
  await assert.rejects(validatePlotApprover({}, 3, null), /Select an admin/);
  await assert.rejects(validatePlotApprover({ query: async () => ({ rows: [] }) }, 3, 8), /active approver/);
  assert.equal(await validatePlotApprover({ query: async (sql, params) => {
    assert.deepEqual(params, [8, 3]);
    assert.match(sql, /is_active = true/);
    assert.match(sql, /us.site_id = \$2/);
    return { rows: [{ id: 8 }] };
  } }, 3, 8), 8);
});

// Runs only against an isolated in-memory PostgreSQL engine, never application credentials.
// Set PGLITE_MODULE to an installed @electric-sql/pglite entry point to run integration coverage.
test('migration and shared single/bulk approvals preserve the plot lifecycle', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users(id integer PRIMARY KEY, name text, email text, role text, is_active boolean DEFAULT true);
      CREATE TABLE sites(id integer PRIMARY KEY, name text);
      CREATE TABLE user_sites(user_id integer, site_id integer);
      CREATE TABLE user_approval_modules(user_id integer, module text);
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE plots(id serial PRIMARY KEY, site_id integer, plot_no text, buyer_name text, status text,
        notes text, assigned_admin_id integer, created_by integer, plot_tag text, updated_at timestamptz DEFAULT now());
      INSERT INTO users VALUES (1, 'Creator', 'c@test.invalid', 'admin'), (2, 'Reviewer', 'r@test.invalid', 'sub_admin'), (3, 'Other', 'o@test.invalid', 'sub_admin');
      INSERT INTO sites VALUES (1, 'Site one'), (2, 'Site two');
      INSERT INTO user_approval_modules VALUES (2, 'plot_payment'), (3, 'plot_payment');
      INSERT INTO plots(site_id, plot_no, status, assigned_admin_id, created_by) VALUES (1, 'LEGACY', 'BOOKED', 2, 1);`);
    const sql = read('../src/migrations/158_plot_status_approval.js').split('export const migrationSql = `')[1].split('`;')[0];
    await db.exec(sql);
    await db.exec(sql);
    const query = async (sql, params) => {
      if (/COUNT\(\*\)/.test(sql) && !sql.includes('plot_status_approvals')) return { rows: [{ count: 0 }], rowCount: 0 };
      const r = await db.query(sql, params);
      return { ...r, rowCount: r.affectedRows ?? r.rows.length };
    };
    const controller = read('../src/controllers/approval.controller.js').replace(/^import[\s\S]*?;\n/gm, '').replace(/export const /g, 'const ');
    const ctx = { pool: { query }, asyncHandler: fn => fn, console,
      hasRelation: async name => (await db.query('SELECT to_regclass($1) IS NOT NULL AS present', [name])).rows[0].present };
    vm.createContext(ctx);
    vm.runInContext(`${controller}\nthis.handlers = { approveEntry, rejectEntry, bulkApprove, bulkReject, listAllPending, getPendingCounts };`, ctx);
    const invoke = async (name, user, opts = {}) => {
      let code = 200, body;
      const req = { user: { ...user, permissionsByModule: new Map([['expense_approval', { can_read: false }]]) }, params: {}, query: {}, body: {}, ...opts };
      await requireApprovalAccess(req, {}, () => {});
      await ctx.handlers[name](req, {
        status(value) { code = value; return this; }, json(value) { body = value; return this; },
      });
      return { code, body };
    };
    const reviewer = { id: 2, role: 'sub_admin' }, other = { id: 3, role: 'sub_admin' };
    const row = async id => (await db.query('SELECT * FROM plots WHERE id = $1', [id])).rows[0];
    assert.equal((await row(1)).approval_status, 'approved');
    for (const status of ['COMPANY', 'BOOKED', 'REGISTRY', 'RESALE', 'CANCEL']) {
      const { rows: [p] } = await db.query(`INSERT INTO plots(site_id, plot_no, buyer_name, status, assigned_admin_id, created_by, scheme)
        VALUES (1, $1, 'Buyer', $2, 2, 1, 'Manual scheme / 10%') RETURNING *`, [status, status]);
      assert.equal(p.approval_status, 'pending');
      assert.equal(p.scheme, 'Manual scheme / 10%');
      const options = { params: { id: p.id }, query: { source: 'plot_status' } };
      assert.equal((await invoke('approveEntry', other, options)).code, 403);
      assert.equal((await invoke('approveEntry', reviewer, options)).code, 200);
      assert.equal((await row(p.id)).status, status);
      assert.equal((await row(p.id)).approval_status, 'approved');
      await db.query("UPDATE plots SET scheme = 'Revised scheme' WHERE id = $1", [p.id]);
      assert.equal((await row(p.id)).approval_status, 'pending');
      assert.equal((await row(p.id)).approved_by, null);
      await invoke('rejectEntry', reviewer, options);
      assert.equal((await row(p.id)).approval_status, 'rejected');
      assert.equal((await invoke('approveEntry', reviewer, options)).code, 409);
      await db.query('UPDATE plots SET approval_requested_at = now(), approval_requested_by = 1 WHERE id = $1', [p.id]);
      assert.equal((await row(p.id)).approval_status, 'pending');
    }
    const queue = await invoke('listAllPending', { id: 1, role: 'admin' }, { query: { module: 'plot_status', site_id: '1', assigned_admin_id: '2' } });
    const entries = queue.body.entries || queue.body;
    assert.equal(entries.length, 5);
    assert.ok(entries.some(e => e.entry_label.includes('BOOKING · Approval pending')));
    assert.ok(entries.every(e => e.source === 'plot_status' && Number(e.amount) === 0));
    assert.equal((await invoke('getPendingCounts', reviewer, { query: { site_id: '1' } })).body.total, 5);
    assert.equal((await invoke('getPendingCounts', other, { query: { site_id: '1' } })).body.total, 0);
    assert.equal((await invoke('listAllPending', other, { query: { module: 'plot_status', site_id: '1' } })).body.entries.length, 0);
    assert.equal((await invoke('listAllPending', other, { query: { module: 'plot_status', site_id: '1', assigned_admin_id: '2' } })).body.entries.length, 0,
      'a forged assignee filter must not reveal another reviewer\'s notifications');
    const items = entries.map(e => ({ source: 'plot_status', id: e.id }));
    await invoke('bulkApprove', reviewer, { body: { items } });
    for (const item of items) assert.equal((await row(item.id)).approval_status, 'approved');
    await db.query("UPDATE plots SET status = 'RESALE' WHERE id = 1");
    assert.equal((await row(1)).approval_status, 'pending');
    await invoke('bulkReject', other, { body: { items: [{ id: 1, source: 'plot_status' }] } });
    assert.equal((await row(1)).approval_status, 'pending');
    await invoke('bulkReject', reviewer, { body: { items: [{ id: 1, source: 'plot_status' }] } });
    assert.equal((await row(1)).approval_status, 'rejected');
    await db.query("UPDATE plots SET plot_tag = 'OLD', updated_at = now() WHERE id = 1");
    assert.equal((await row(1)).approval_status, 'rejected');
    await db.query("UPDATE plots SET notes = 'Corrected buyer details', approval_requested_by = 3 WHERE id = 1");
    const editedQueue = await invoke('listAllPending', reviewer, { query: { module: 'plot_status', site_id: '1' } });
    assert.equal(editedQueue.body.entries.length, 1, 'a non-status edit must notify the assigned reviewer');
    assert.equal(editedQueue.body.entries[0].id, 1);
    assert.equal(editedQueue.body.entries[0].created_by_name, 'Other');
    await db.query('UPDATE plots SET assigned_admin_id = 3 WHERE id = 1');
    assert.equal((await invoke('listAllPending', reviewer, { query: { module: 'plot_status', site_id: '1' } })).body.entries.length, 0);
    assert.equal((await invoke('listAllPending', other, { query: { module: 'plot_status', site_id: '1' } })).body.entries.length, 1);
    assert.equal((await invoke('listAllPending', other, { query: { module: 'plot_status', site_id: '2' } })).body.entries.length, 0);
    await db.query('UPDATE plots SET assigned_admin_id = NULL WHERE id = 1');
    const unassigned = { params: { id: 1 }, query: { source: 'plot_status' } };
    assert.equal((await invoke('approveEntry', reviewer, unassigned)).code, 403);
    assert.equal((await invoke('rejectEntry', reviewer, unassigned)).code, 403);
    for (const action of ['bulkApprove', 'bulkReject']) {
      await invoke(action, reviewer, { body: { items: [{ id: 1, source: 'plot_status' }] } });
      assert.equal((await row(1)).approval_status, 'pending', 'assignment access must not decide unassigned plots, even with a module grant');
    }
  } finally { await db.close(); }
});
