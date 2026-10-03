import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../src/services/driveShareDestination.service.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
const harness = (rows = []) => {
  const queries = [];
  const pool = { query: async (sql, args) => { queries.push({ sql, args }); return { rows }; } };
  const get = new Function('pool', 'MODULE_FOLDER', `${source}; return existingShareFolderSegments;`)(pool, 'Project Commission');
  return { get, queries };
};
const context = { orgId: 1, siteId: 2, plotId: 4, rootFolderId: 'current-drive-root' };
const nextDay = ['04-10-2026', 'Project Commission', 'New Agent - Plot A4'];

test('a later upload and renamed agent keep the original plot folder', async () => {
  const h = harness([{ path: 'site:2/03-10-2026/Project Commission/Old Agent - Plot A4' }]);
  assert.deepEqual(await h.get(context, nextDay), ['03-10-2026', 'Project Commission', 'Old Agent - Plot A4']);
  assert.deepEqual(h.queries[0].args, [1, 2, 4, 'current-drive-root', 'site:2/']);
  assert.match(h.queries[0].sql, /s\.site_id=\$2/);
  assert.match(h.queries[0].sql, /s\.entity_id=\$3/);
  assert.match(h.queries[0].sql, /f\.root_folder_id=\$4/);
  assert.match(h.queries[0].sql, /ORDER BY s\.id ASC/);
});

test('new connections and plots without a matching current-root folder use the new destination', async () => {
  const h = harness();
  assert.equal(await h.get({ ...context, rootFolderId: null }, nextDay), nextDay);
  assert.equal(h.queries.length, 0);
  assert.equal(await h.get(context, nextDay), nextDay);
  assert.equal(h.queries.length, 1);
});

test('malformed or unrelated cached paths are never adopted', async () => {
  for (const path of ['site:2/03-10-2026/Other module/A4', 'site:2/03-10-2026/Project Commission/A4/Extra', 'site:2//Project Commission/A4']) {
    assert.equal(await harness([{ path }]).get(context, nextDay), nextDay);
  }
});

const controllerSource = (await readFile(new URL('../src/controllers/driveShare.controller.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];$/gm, '').replace(/^export /gm, '');
const controllers = (overrides = {}) => {
  const queries = [];
  const deps = {
    pool: { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [] }; } },
    asyncHandler: (fn) => fn,
    MODULE_KEY: 'plot_commission',
    permissionModel: { getPermission: async () => ({ can_read: true }) },
    assertCommissionSite: async () => {},
    resolveEntryVisibility: async () => ({ canViewAll: false, creatorId: 8 }),
    sendDriveError: (_res, err) => { throw err; },
    ...overrides,
  };
  const handlers = new Function(...Object.keys(deps), `${controllerSource}; return {listPlotCommissionShares, getShare};`)(...Object.values(deps));
  return { ...handlers, queries };
};
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const user = { id: 8, organization_id: 1, role: 'sub_admin' };

test('hover history is filtered by the authorized site and requesting user visibility', async () => {
  const h = controllers();
  const res = response();
  await h.listPlotCommissionShares({ params: { plotId: '4' }, query: { site_id: '2' }, user }, res);
  assert.deepEqual(h.queries[0].args, [1, 'plot_commission', 4, 50, 2, false, 8]);
  assert.match(h.queries[0].sql, /s\.site_id=\$5/);
  assert.match(h.queries[0].sql, /s\.scope='transaction' AND s\.shared_by=\$7/);
  assert.deepEqual(res.body, { shares: [] });
});

test('restricted progress requests cannot reveal a full or another user\'s share', async () => {
  for (const row of [
    { organization_id: 1, site_id: 2, scope: 'overall', shared_by: 8 },
    { organization_id: 1, site_id: 2, scope: 'transaction', shared_by: 9 },
  ]) {
    const h = controllers({ getShareRow: async () => row });
    const res = response();
    await h.getShare({ params: { id: '1' }, user }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { message: 'Share not found' });
    assert.equal(h.queries.length, 0);
  }
});
