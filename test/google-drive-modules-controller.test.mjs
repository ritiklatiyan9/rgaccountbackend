import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeModuleDriveFilters } from '../src/services/tdsDriveReport.service.js';

const source = (await readFile(new URL('../src/controllers/moduleDriveShare.controller.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];$/gm, '').replace(/^export /gm, '');
const user = { id: 8, organization_id: 1, role: 'sub_admin' };
const definition = { key: 'plot_payments', label: 'Plot Payments', entityScoped: true, entityType: 'plot' };
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const harness = (overrides = {}) => {
  const queries = [], calls = [];
  const deps = {
    asyncHandler: (fn) => fn, normalizeModuleDriveFilters,
    getModuleDriveDefinition: (key) => key === definition.key ? definition : null,
    listModuleDriveDefinitions: () => [definition, { key: 'legal', label: 'Legal' }],
    assertModuleDriveAccess: async (args) => { calls.push(args); if (args.moduleKey === 'legal') throw Object.assign(new Error('denied'), { statusCode: 403 }); return { canViewAll: false, creatorId: 8 }; },
    pool: { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [] }; } },
    sendDriveError: (_res, err) => { throw err; },
    ...overrides,
  };
  return { ...new Function(...Object.keys(deps), `${source}; return { listDriveShareModules, listModuleShares, createModuleShare, assertModuleShareVisible };`)(...Object.values(deps)), queries, calls };
};
const req = (query = {}) => ({ user, params: { moduleKey: 'plot_payments' }, query: { site_id: '2', ...query } });

test('catalog only includes modules authorized for the selected site', async () => {
  const h = harness(); const res = response();
  await h.listDriveShareModules(req(), res);
  assert.deepEqual(res.body, { modules: [{ ...definition, entry_scope: 'own' }] });
  assert.ok(h.calls.every((call) => call.siteId === 2 && call.user === user));
  const empty = response(); await h.listDriveShareModules(req({ site_id: '' }), empty);
  assert.deepEqual(empty.body, { modules: [] });
});

test('module history isolates organization, site, module, record type and prior visibility', async () => {
  const h = harness(); const res = response();
  await h.listModuleShares(req({ entity_id: '4' }), res);
  assert.deepEqual(h.queries[0].args, [1, 'plot_payments', 2, 'plot', 4, false, 8, 50]);
  assert.match(h.queries[0].sql, /s\.request->'visibility'->>'canViewAll'='false'/);
  assert.match(h.queries[0].sql, /s\.shared_by=\$7/);
  await h.listModuleShares(req(), response());
  assert.deepEqual(h.queries[1].args.slice(3, 5), ['module', 2]);
});

test('module requests reject unknown datasets, arbitrary record scopes and slow conversion options', async () => {
  const h = harness();
  for (const query of [{ site_id: 'invalid' }, { entity_id: '-1' }, { formats: 'xlsx,pdf' }, { scope: 'documents' }, { include_documents: 'true' }]) {
    await assert.rejects(h.listModuleShares(req(query), response()), (err) => err.statusCode === 400);
  }
  await assert.rejects(h.listModuleShares({ ...req(), params: { moduleKey: 'users' } }, response()), /Unknown/);
  assert.equal(h.queries.length, 0);
});

test('restricted progress cannot reveal a previously full or another user export', async () => {
  const h = harness();
  const row = { module: 'plot_payments', site_id: 2, shared_by: 8, request: { visibility: { canViewAll: false, creatorId: 8 } } };
  await h.assertModuleShareVisible(user, row);
  for (const change of [{ shared_by: 9 }, { request: { visibility: { canViewAll: true, creatorId: null } } }, { request: {} }, { request: { visibility: { canViewAll: false, creatorId: 9 } } }]) {
    await assert.rejects(h.assertModuleShareVisible(user, { ...row, ...change }), (err) => err.statusCode === 404);
  }
});

test('module POST queues before loading or rendering a full dataset so progress starts promptly', async () => {
  let queued;
  const h = harness({
    driveClientFor: async () => ({ connection: { root_folder_id: 'root', root_folder_name: 'Accounts' } }),
    buildModuleDriveShareBundle: () => assert.fail('Full export queries belong in the progress-reporting worker'),
    pool: { query: async (sql) => ({ rows: sql.includes('SELECT id,name FROM sites') ? [{ id: 2, name: 'Site A' }] : [] }) },
    existingModuleShareFolderSegments: async (_args, fallback) => fallback,
    istDateFolder: () => '03-10-2026', safeFilePart: (value) => value, siteFolderName: (site) => site.name,
    folderPathKey: (parts) => parts.join('/'), MODULE_ROOT_NAME: 'Accounts',
    enqueueShare: async (args) => { queued = args; return { id: 42, status: 'queued', request: args.request }; },
  });
  const res = response();
  await h.createModuleShare({ ...req(), body: { site_id: 2, formats: ['xlsx'] } }, res);
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.share.status, 'queued');
  assert.equal(res.body.share.request, undefined);
  assert.equal(queued.moduleKey, 'plot_payments');
  assert.equal(queued.entityType, 'module');
  assert.equal(queued.entityId, 2);
  assert.deepEqual(queued.request.visibility, { canViewAll: false, creatorId: 8 });
  assert.equal(queued.prepared, undefined);
});

test('TDS preview filters are validated and preserved in the queued request for the worker', async () => {
  let queued;
  const tds = { key: 'tds', label: 'TDS Register' };
  const h = harness({
    getModuleDriveDefinition: key => key === 'tds' ? tds : null,
    driveClientFor: async () => ({ connection: { root_folder_id: 'root', root_folder_name: 'Accounts' } }),
    pool: { query: async sql => ({ rows: sql.includes('SELECT id,name FROM sites') ? [{ id: 2, name: 'Site A' }] : [] }) },
    existingModuleShareFolderSegments: async (_args, fallback) => fallback,
    istDateFolder: () => '10-10-2026', safeFilePart: value => value, siteFolderName: site => site.name,
    folderPathKey: parts => parts.join('/'), MODULE_ROOT_NAME: 'Accounts',
    enqueueShare: async args => { queued = args; return { id: 42, status: 'queued', request: args.request }; },
  });
  const filters = { date_from: '2026-10-01', date_to: '2026-10-31', status: 'due', source_module: 'expense', pan: 'present' };
  await h.createModuleShare({ ...req(), params: { moduleKey: 'tds' }, body: { site_id: 2, filters } }, response());
  assert.deepEqual(queued.request.filters, filters);
  await assert.rejects(h.createModuleShare({ ...req(), params: { moduleKey: 'tds' }, body: { site_id: 2, filters: { creatorId: 1 } } }, response()), { statusCode: 400 });
});
