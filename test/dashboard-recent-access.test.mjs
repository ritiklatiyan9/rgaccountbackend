import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { attachTransactionParticulars } from '../src/services/transactionParticulars.service.js';

const controller = await readFile(new URL('../src/controllers/daybook.controller.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/routes/daybook.routes.js', import.meta.url), 'utf8');
const start = controller.indexOf('export const listRecentTransactions =');
const end = controller.indexOf('\n// ═', start);
assert.ok(start >= 0 && end > start, 'load the actual recent-transactions controller');
const handlerSource = controller.slice(start, end).replace('export const ', 'const ');

function createHarness({ role = 'sub_admin', siteAccess = true, canViewAll = false, entries } = {}) {
  const calls = [];
  const visibilityCalls = [];
  const receipts = [];
  const particularsCalls = [];
  const row = { id: 500, site_id: 5, date: '2026-10-18', debit: '1250', credit: '0',
    source_module: 'expenses', source_id: 81, particular: 'Supplies', cash_type: 'CASH' };
  const pool = { async query(sql, params) {
    calls.push({ sql, params: [...params] });
    if (sql.includes('FROM user_sites')) return { rows: siteAccess ? [{ allowed: 1 }] : [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ total: 31 }] };
    if (sql.includes('FROM cash_flow_entries cfe')) return { rows: (entries || [row]).map(value => ({ ...value })) };
    if (sql.includes('FROM sites WHERE')) return { rows: [{ name: 'Site 5', city: 'Meerut', state: 'UP' }] };
    if (sql.includes('AS linked_client_name')) return { rows: [
      { source_key: 'expenses', source_id: 81, party_name: 'Native expense party', linked_client_name: 'Linked Client', category: 'Office' },
      { source_key: 'personal_ledger', source_id: 501, party_name: 'Ledger owner', ledger_name: 'Ledger owner', ledger_type: 'person' },
    ] };
    throw new Error(`Unexpected database query: ${sql}`);
  } };
  const context = vm.createContext({
    asyncHandler: handler => handler,
    pool,
    async resolveEntryVisibility(...args) {
      visibilityCalls.push(args);
      return { canViewAll, creatorId: canViewAll ? null : 9 };
    },
    async attachChequeDates(rows, database, reference) {
      assert.equal(database, pool);
      assert.deepEqual(structuredClone(reference(rows[0])), { ledgerId: 500, siteId: 5 });
    },
    async attachTransactionParticulars(rows, database) {
      particularsCalls.push(structuredClone(rows));
      return attachTransactionParticulars(rows, database);
    },
    buildVerifyUrl(data) { receipts.push(data); return 'https://example.test/verify'; },
    RECENT_RECEIPT_TYPE: { expenses: 'expense' },
    ReceiptType: { DAYBOOK: 'daybook' },
  });
  vm.runInContext(`${handlerSource}\nthis.run=listRecentTransactions;`, context);
  const res = { statusCode: 200, headers: {}, payload: undefined,
    status(value) { this.statusCode = value; return this; },
    set(key, value) { this.headers[key] = value; return this; },
    json(value) { this.payload = value; return this; },
  };
  const user = { id: 9, role, organization_id: 1 };
  return { calls, visibilityCalls, receipts, particularsCalls, res, user,
    async request(query = {}) { await context.run({ query, user }, res); return res; } };
}

test('Dashboard recent transactions reject invalid sites before database reads', async () => {
  for (const site_id of [undefined, '', '2junk', '0', '-5', '1.5', 'Infinity', '9007199254740992']) {
    const harness = createHarness();
    const response = await harness.request({ site_id });
    assert.equal(response.statusCode, 400, String(site_id));
    assert.equal(harness.calls.length, 0);
    assert.equal(harness.visibilityCalls.length, 0);
    assert.equal(response.payload.transactions, undefined);
  }
});

test('a sub-admin cannot read another site or trigger transaction queries there', async () => {
  const harness = createHarness({ siteAccess: false });
  const response = await harness.request({ site_id: '5' });
  assert.equal(response.statusCode, 403);
  assert.match(response.payload.message, /Access denied/);
  assert.equal(harness.calls.length, 1);
  assert.match(harness.calls[0].sql, /FROM user_sites/);
  assert.deepEqual(harness.calls[0].params, [9, 5]);
  assert.equal(harness.visibilityCalls.length, 0);
  assert.equal(harness.receipts.length, 0);
});

test('restricted recent reads apply the current creator to both count and rows', async () => {
  const harness = createHarness();
  const response = await harness.request({ site_id: '5', limit: '12', page: '2', created_by: '777' });
  assert.equal(response.statusCode, 200);
  assert.equal(harness.visibilityCalls.length, 1);
  assert.equal(harness.visibilityCalls[0][0], harness.user);
  assert.equal(harness.visibilityCalls[0][1], 'daybook');
  assert.equal(harness.visibilityCalls[0][2], null, 'URL parameters cannot widen creator visibility');
  const count = harness.calls.find(call => call.sql.includes('COUNT(*)'));
  const list = harness.calls.find(call => call.sql.includes('FROM cash_flow_entries cfe'));
  assert.deepEqual(count.params, [5, 9]);
  assert.deepEqual(list.params, [5, 12, 12, 9]);
  assert.match(count.sql, /created_by\s*=\s*\$2/);
  assert.match(list.sql, /cfe\.created_by\s*=\s*\$4/);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(structuredClone(response.payload.pagination), { totalItems: 31, totalPages: 3, currentPage: 2 });
  assert.equal(response.payload.transactions[0].source_id, 81);
  assert.equal(response.payload.transactions[0].party_name, 'Native expense party');
  assert.equal(response.payload.transactions[0].linked_client_name, 'Linked Client');
  assert.equal(harness.receipts[0].i, 'expenses_81', 'receipt identity follows the native transaction');
  assert.equal(harness.receipts[0].pn, 'Linked Client');
});

test('recent party enrichment uses one source batch and preserves mirror and native identities', async () => {
  const entries = [
    { id: 500, site_id: 5, date: '2026-10-18', debit: '1250', credit: '0', source_module: 'expenses', source_id: 81, particular: 'Generated expense narration' },
    { id: 501, site_id: 5, date: '2026-10-18', debit: '0', credit: '500', source_module: null, source_id: null, particular: 'Generated ledger narration' },
  ];
  const harness = createHarness({ entries });
  const response = await harness.request({ site_id: '5' });
  assert.equal(harness.particularsCalls.length, 1);
  assert.deepEqual(harness.particularsCalls[0].map(row => [row.id, row.source_key, row.source_id]), [
    [500, 'expenses', 81], [501, 'personal_ledger', 501],
  ]);
  const metadataQueries = harness.calls.filter(call => call.sql.includes('AS linked_client_name'));
  assert.equal(metadataQueries.length, 1, 'source parties are fetched in one union query');
  assert.match(metadataQueries[0].sql, /UNION ALL/);
  const [expense, ledger] = response.payload.transactions;
  assert.deepEqual([expense.id, expense.source_module, expense.source_id], [500, 'expenses', 81]);
  assert.deepEqual([ledger.id, ledger.source_module, ledger.source_id], [501, null, null]);
  assert.equal(expense.linked_client_name, 'Linked Client');
  assert.equal(ledger.party_name, 'Ledger owner');
  assert.equal(ledger.ledger_name, 'Ledger owner');
  assert.equal(harness.receipts[1].i, 'cashflow_501');
  assert.equal(harness.receipts[1].pn, 'Ledger owner');
});

test('cash-flow source aliases use the personal-ledger presentation lookup without changing their references', async () => {
  for (const source_module of ['cash_flow_entries', 'cashflow', 'cashflow_entry', 'personal_ledger']) {
    const harness = createHarness({ entries: [{ id: 500, site_id: 5, source_module, source_id: 501, debit: 10 }] });
    const response = await harness.request({ site_id: '5' });
    assert.equal(harness.particularsCalls[0][0].source_key, 'personal_ledger');
    assert.equal(response.payload.transactions[0].source_module, source_module);
    assert.equal(response.payload.transactions[0].source_id, 501);
    assert.equal(response.payload.transactions[0].party_name, 'Ledger owner');
  }
});

test('a view-all sub-admin retains the site boundary but does not receive a creator filter', async () => {
  const harness = createHarness({ canViewAll: true });
  const response = await harness.request({ site_id: '5', limit: '500' });
  assert.equal(response.statusCode, 200);
  assert.ok(harness.calls.some(call => call.sql.includes('FROM user_sites')));
  assert.deepEqual(harness.calls.find(call => call.sql.includes('COUNT(*)')).params, [5, null]);
  assert.deepEqual(harness.calls.find(call => call.sql.includes('FROM cash_flow_entries cfe')).params, [5, 50, 0, null]);
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('admins read all creators without a sub-admin site grant lookup', async () => {
  for (const role of ['admin', 'super_admin']) {
    const harness = createHarness({ role, canViewAll: true });
    const response = await harness.request({ site_id: '5' });
    assert.equal(response.statusCode, 200);
    assert.equal(harness.calls.some(call => call.sql.includes('FROM user_sites')), false);
    assert.deepEqual(harness.calls.find(call => call.sql.includes('COUNT(*)')).params, [5, null]);
    assert.deepEqual(harness.calls.find(call => call.sql.includes('FROM cash_flow_entries cfe')).params, [5, 10, 0, null]);
    assert.equal(response.headers['Cache-Control'], 'no-store');
  }
});

test('the recent route requires Day Book read permission before reaching the handler', () => {
  const registration = routes.split('\n').find(line => /^router\.get\('\/recent'/.test(line));
  assert.ok(registration, 'recent route exists');
  const middleware = [];
  let handlerRuns = 0;
  const context = vm.createContext({
    router: { get(path, ...handlers) { assert.equal(path, '/recent'); middleware.push(...handlers); } },
    requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Role denied' }),
    requirePermission: (module, action) => {
      assert.equal(module, 'daybook'); assert.equal(action, 'read');
      return (req, res, next) => req.allowed ? next() : res.status(403).json({ message: 'Permission denied' });
    },
    listRecentTransactions: () => { handlerRuns += 1; },
  });
  vm.runInContext(registration, context);
  const execute = allowed => {
    const req = { user: { role: 'sub_admin' }, allowed };
    const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json() { return this; } };
    let index = 0;
    const next = () => middleware[index++]?.(req, res, next);
    next();
    return res;
  };
  assert.equal(execute(false).statusCode, 403);
  assert.equal(handlerRuns, 0);
  assert.equal(execute(true).statusCode, 200);
  assert.equal(handlerRuns, 1);
});
