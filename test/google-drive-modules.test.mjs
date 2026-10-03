import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REPORTS } from '../src/services/reportDefinitions.js';

// Execute the production adapter without DB, S3 or Google side effects. Only
// import/export wiring is replaced, all authorization and SQL building is real.
const source = (await readFile(new URL('../src/services/moduleDriveShare.service.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const admin = { id: 8, role: 'admin', organization_id: 3, name: 'Operator' };
const subAdmin = { ...admin, role: 'sub_admin' };
const site = { id: 2, name: 'Test Site', city: 'Test', state: 'Test' };

function harness(options = {}) {
  const calls = { queries: [], adapters: [], links: [], balance: [] };
  const deps = {
    REPORTS,
    pool: { query: async (sql, values) => {
      calls.queries.push({ sql, values });
      if (options.query) {
        const override = await options.query(sql, values);
        if (override) return { rows: override };
      }
      if (sql.startsWith('SELECT id FROM sites')) return { rows: options.noSite ? [] : [{ id: 2 }] };
      if (sql.startsWith('SELECT id,name,city,state,address')) return { rows: [site] };
      if (sql.startsWith('SELECT 1 FROM user_sites')) return { rows: options.noMembership ? [] : [{ '?column?': 1 }] };
      if (sql.includes('FROM user_permissions')) return { rows: [options.permission ?? { can_read: true, can_view_all: false }] };
      if (sql.startsWith('SELECT id,plot_no')) return { rows: [{ id: 20, plot_no: 'A-1' }] };
      return { rows: [] };
    } },
    loadModuleReport: async (key, siteId, creatorId) => {
      calls.adapters.push({ key, siteId, creatorId });
      return options.adapter?.(key) ?? [];
    },
    resolveEntryVisibility: async (user, permission) => {
      const all = ['admin', 'super_admin'].includes(user.role) || user.permissionsByModule?.get(permission)?.can_view_all === true;
      return { canViewAll: all, creatorId: all ? null : Number(user.id) };
    },
    balanceSheetModel: { getReport: async (args) => {
      calls.balance.push(args);
      return options.balance ?? { transactions: [] };
    } },
    istDateFolder: () => '2026-10-03',
    siteFolderName: (value) => `${value.id}-${value.name}`,
    safeFilePart: (value) => value.replace(/[/\\]/g, '-'),
    prepareDriveDocumentLinks: async (args) => {
      calls.links.push(args);
      return args.documents.map(({ url: _url, ...doc }) => ({ ...doc, url: `https://example.test/public/drive-documents/${doc.id}`, sourceFingerprint: 'safe-hash', linkVersion: 'v1' }));
    },
  };
  return { calls, ...new Function(...Object.keys(deps), `${source}\nreturn {getModuleDriveDefinition,listModuleDriveDefinitions,assertModuleDriveAccess,buildModuleDriveShareBundle,planModuleDriveShareFiles};`)(...Object.values(deps)) };
}
const build = (h, moduleKey, overrides = {}) => h.buildModuleDriveShareBundle({ moduleKey, siteId: 2, user: admin, ...overrides });

test('catalog is canonical and every module produces one Excel plan without database mutations', async () => {
  const h = harness();
  const catalog = h.listModuleDriveDefinitions();
  assert.equal(new Set(catalog.map((d) => d.key)).size, catalog.length);
  for (const key of ['plots', 'plot_payments', 'registry', 'farmers', 'land_sale', 'expenses', 'misc_income', 'vendors', 'procurement', 'daybook', 'cashflow', 'personal_ledgers', 'balance_sheet', 'imprest', 'wallet', 'banking', 'bank_reconciliation', 'tds', 'construction', 'inventory', 'documents', 'document_imprest', 'compliance', 'legal', 'partner_finance', 'clients', 'upi_collect', 'excel', 'finance_forecast', 'management_analytics']) {
    assert.ok(h.getModuleDriveDefinition(key), key);
  }
  assert.equal(h.getModuleDriveDefinition('users'), null);
  for (const definition of catalog) {
    const bundle = await build(h, definition.key);
    assert.equal(bundle.entityType, 'module');
    assert.equal(bundle.entityId, 2);
    const name = bundle.entryVisibility.canViewAll ? bundle.label : `${bundle.label} - Entries by User ${bundle.entryVisibility.creatorId}`;
    assert.deepEqual(h.planModuleDriveShareFiles(bundle), [{ folder: 'Excel Reports', name, kind: 'module_report', formats: ['xlsx'] }]);
    for (const sheet of bundle.sheets) {
      assert.equal(new Set(sheet.columns.map((column) => column.key)).size, sheet.columns.length, `${definition.key} duplicate columns`);
      assert.ok(sheet.columns.length > 0);
    }
  }
  assert.ok(h.calls.queries.every(({ sql }) => sql.trim().startsWith('SELECT')));
});

test('site, membership, role and strict read permission are checked before financial data', async () => {
  for (const [options, user] of [[{ noSite: true }, admin], [{ noMembership: true }, subAdmin], [{ permission: { can_read: 'true', can_view_all: true } }, subAdmin], [{}, { ...admin, role: 'user' }]]) {
    const h = harness(options);
    await assert.rejects(build(h, 'expenses', { user }), { statusCode: 403 });
    assert.equal(h.calls.adapters.length, 0);
    assert.equal(h.calls.links.length, 0);
  }
  const h = harness();
  await assert.rejects(build(h, 'expenses', { siteId: '2;SELECT secret' }), { statusCode: 400 });
  await assert.rejects(build(h, 'legal', { user: subAdmin }), { statusCode: 403 });
  await assert.rejects(build(h, 'banking', { user: subAdmin }), { statusCode: 403 });
  await assert.rejects(build(h, 'expenses', { entityId: 5 }), { statusCode: 400 });
});

test('concurrent catalog checks coalesce authorization only while in flight; revocation is reread', async () => {
  let permission = { can_read: true, can_view_all: true };
  const h = harness({ query: async (sql) => sql.includes('FROM user_permissions') ? [permission] : undefined });
  await Promise.all(['expenses', 'expenses', 'expenses'].map((moduleKey) => h.assertModuleDriveAccess({ moduleKey, siteId: 2, user: subAdmin })));
  assert.equal(h.calls.queries.filter(({ sql }) => sql.includes('FROM user_permissions')).length, 1);
  assert.equal(h.calls.queries.filter(({ sql }) => sql.includes('SELECT id FROM sites')).length, 1);
  permission = { can_read: false, can_view_all: true };
  await assert.rejects(h.assertModuleDriveAccess({ moduleKey: 'expenses', siteId: 2, user: subAdmin }), { statusCode: 403 });
  assert.equal(h.calls.queries.filter(({ sql }) => sql.includes('FROM user_permissions')).length, 2);
});

test('restricted payment export re-resolves visibility, retains all rows and prepares safe CA links', async () => {
  const rows = Array.from({ length: 2601 }, (_, i) => ({ id: i + 1, amount: i, voucher_url: `private/${i}.pdf`, password: 'secret', raw_json: { token: 'secret' } }));
  const h = harness({ adapter: () => rows });
  const bundle = await build(h, 'expenses', { user: subAdmin, entryVisibility: { canViewAll: true, creatorId: null } });
  assert.deepEqual(h.calls.adapters, [{ key: 'expenses', siteId: 2, creatorId: 8 }]);
  assert.equal(bundle.sheets[0].rows.length, 2601);
  assert.equal(bundle.summary.document_count, 2601);
  assert.equal(h.calls.links[0].orgId, 3);
  assert.equal(h.calls.links[0].siteId, 2);
  assert.equal(h.calls.links[0].documents[0].url, 'private/0.pdf');
  assert.match(bundle.documents[0].url, /^https:\/\/example.test\/public\/drive-documents\//);
  assert.equal(JSON.stringify(bundle).includes('secret'), false);
  assert.equal(Object.hasOwn(bundle.sheets[0].rows[0], 'voucher_url'), false);
  assert.equal(h.planModuleDriveShareFiles(bundle)[0].name, `${bundle.label} - Entries by User 8`);
  assert.equal(bundle.folderSegments.at(-1).includes('Entries by User'), false);
});

test('plot record exports include old bookings by plot number and preserve creator scope without shared documents', async () => {
  const h = harness();
  const bundle = await build(h, 'plot_payments', { entityId: 20, user: subAdmin });
  const query = h.calls.queries.find(({ sql }) => sql.includes('FROM plot_payments pp'));
  assert.deepEqual(query.values, [2, 8, 20, 8]);
  assert.match(query.sql, /pp\.created_by = ANY/);
  assert.match(query.sql, /p_scope\.plot_no=\(SELECT plot_no/);
  assert.equal(h.calls.queries.some(({ sql }) => sql.includes('FROM documents')), false);
  assert.equal(bundle.entityType, 'plot');
  assert.equal(bundle.entityId, 20);
  assert.equal(bundle.label, 'Plot A-1');
  const adminHarness = harness();
  await build(adminHarness, 'plots', { entityId: 20 });
  const documentQuery = adminHarness.calls.queries.find(({ sql }) => sql.includes('FROM documents'));
  assert.deepEqual(documentQuery.values, [2, 20]);
  assert.equal(documentQuery.sql.includes('$3'), false);
});

test('personal ledgers export full scoped entries with matching no-duplicate rules and actual summary fields', async () => {
  const h = harness({ adapter: (key) => key === 'personal_ledgers' ? [{ id: 1, ledger_name: 'Employee', total_debit: 50, entry_count: 1, linked_user_email: 'private@test' }] : [] });
  const bundle = await build(h, 'personal_ledgers', { user: subAdmin });
  assert.equal(bundle.sheets.length, 2);
  assert.equal(bundle.sheets[0].rows[0].ledger_name, 'Employee');
  const query = h.calls.queries.find(({ sql }) => sql.includes('FROM cash_flow_entries e'));
  assert.match(query.sql, /e\.created_by = ANY/);
  assert.match(query.sql, /m\.ledger_type='person'/);
  assert.match(query.sql, /!~ '_person\$'/);
  assert.equal(query.values[1], 8);
  assert.equal(query.sql.includes('LIMIT'), false);
  assert.equal(JSON.stringify(bundle).includes('private@test'), false);
});

test('historical receipt evidence is fetched only for exported payment IDs with tenant/site constraints', async () => {
  const h = harness({ query: async (sql) => {
    if (sql.includes('FROM plot_payments pp')) return [{ id: 20, amount: 150, voucher_url: 'private/voucher.pdf' }];
    if (sql.includes('FROM transaction_receipts')) return [{ id: '20', module: 'plot_payment', evidence_photo_url: 'private/evidence.jpg' }];
  } });
  const bundle = await build(h, 'plot_payments', { user: subAdmin });
  const query = h.calls.queries.find(({ sql }) => sql.includes('FROM transaction_receipts'));
  assert.deepEqual(query.values.slice(0, 2), [3, 2]);
  assert.deepEqual(JSON.parse(query.values[2]), [{ module: 'plot_payment', record_id: '20' }]);
  assert.match(query.sql, /r\.organization_id=\$1/);
  assert.match(query.sql, /r\.site_id=\$2/);
  assert.equal(bundle.documents.length, 2);
  assert.ok(bundle.documents.every((doc) => doc.url.startsWith('https://example.test/public/drive-documents/')));
});

test('multiple vouchers and bills are deduplicated before CA link creation', async () => {
  const h = harness({ adapter: () => [{ id: 1, debit: 100, to_entity: 'Supplier', voucher_url: 'a.pdf', voucher_urls: ['a.pdf', 'b.pdf'], bill_urls: ['c.pdf'], bill_url: 'c.pdf' }] });
  const bundle = await build(h, 'expenses');
  assert.equal(bundle.documents.length, 3);
  assert.equal(bundle.sheets[0].rows[0].to_entity, 'Supplier');
  assert.ok(bundle.sheets[0].columns.some((c) => c.key === 'to_entity' && c.label === 'Paid To'));
  assert.equal(bundle.sheets[0].columns.some((c) => c.key === 'plot_no'), false);
  assert.equal(h.calls.links[0].documents.length, 3);
});

test('wallet is always personal and site constrained, including for administrators', async () => {
  const h = harness();
  const bundle = await build(h, 'wallet');
  const query = h.calls.queries.find(({ sql }) => sql.includes('FROM wallet_entries'));
  assert.match(query.sql, /e\.user_id=\$4::int/);
  assert.match(query.sql, /details->>'site_id'/);
  assert.deepEqual(query.values, [2, 8, null, 8]);
  assert.deepEqual(bundle.entryVisibility, { canViewAll: false, creatorId: 8 });
  assert.equal(query.sql.includes('balance_after'), false);
});

test('balance sheet is unpaginated and restricted exports exclude sitewide imprest and quality totals', async () => {
  const h = harness({ balance: { summary: { total_credit: 10, imprest_float: 990, balance_in_hand: 999, total_entries: 1 }, transactions: [{ id: 1, credit: 10 }], by_source: [{ source_key: 'expenses', total_credit: 10 }], quality: { globalSecret: 'hidden' } } });
  const bundle = await build(h, 'balance_sheet', { user: subAdmin });
  assert.equal(h.calls.balance[0].limit, 2147483647);
  assert.equal(h.calls.balance[0].creatorId, 8);
  assert.equal(bundle.sheets.length, 5);
  const summary = bundle.sheets[0].rows[0];
  assert.equal(summary.total_credit, 10);
  assert.equal(Object.hasOwn(summary, 'imprest_float'), false);
  assert.equal(Object.hasOwn(summary, 'balance_in_hand'), false);
  assert.equal(JSON.stringify(bundle).includes('hidden'), false);
});

test('transaction and cheque reconciliation use separate workflows, permissions, and tenant-safe explicit projections', async () => {
  for (const [key, workflow, permission] of [['transaction_reconciliation', 'TRANSACTION', 'daybook'], ['cheque_reconciliation', 'CHEQUE', 'expense_approval']]) {
    const h = harness();
    const definition = h.getModuleDriveDefinition(key);
    assert.equal(definition.permission, permission);
    assert.equal(definition.requiresViewAll, true);
    await assert.rejects(build(h, key, { user: subAdmin }), { statusCode: 403 });
    await build(h, key);
    const queries = h.calls.queries.filter(({ sql }) => sql.includes('bank_statement_uploads'));
    assert.ok(queries.length >= 2);
    for (const { sql, values } of queries) {
      assert.ok(sql.includes(`u.workflow='${workflow}'`));
      assert.match(sql, /organization_id=\$5::int/);
      assert.deepEqual(values, [2, null, null, 8, 3]);
      assert.equal(/entry_snapshot|raw_row|normalized_row|provider_request/.test(sql), false);
    }
  }
});

test('client documents use site registrations and allowlisted KYC links without widening to shared profile IDs', async () => {
  const h = harness({ query: async (sql) => sql.includes('FROM members mb') ? [{ id: 4, full_name: 'Client', member_type: 'CLIENT, FARMER', aadhar_front_url: 'private/front.jpg', photo: 'private/photo.jpg' }] : undefined });
  const bundle = await build(h, 'clients');
  const memberQuery = h.calls.queries.find(({ sql }) => sql.includes('FROM members mb'));
  assert.match(memberQuery.sql, /mb\.site_id=\$1/);
  assert.equal(memberQuery.sql.includes('shared_profile_id'), false);
  assert.equal(bundle.sheets[0].rows[0].id, 4);
  assert.equal(bundle.sheets[0].rows[0].member_type, 'CLIENT, FARMER');
  assert.equal(bundle.documents.length, 2);
  assert.ok(bundle.documents.every((doc) => doc.url.startsWith('https://example.test/public/drive-documents/')));
  assert.equal(Object.hasOwn(bundle.sheets[0].rows[0], 'aadhar_front_url'), false);
});
