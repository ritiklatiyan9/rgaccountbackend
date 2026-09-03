import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('every spreadsheet route sits behind authentication and the excel module RBAC', async () => {
  const routes = await source('src/routes/spreadsheet.routes.js');
  assert.match(routes, /router\.use\(authMiddleware\)/);
  const routeLines = routes.split('\n').filter((line) => /^router\.(get|post|put|patch|delete)\(/.test(line));
  assert.ok(routeLines.length >= 15);
  for (const line of routeLines) assert.match(line, /requirePermission\('excel',\s*'(read|write|update|delete|restore)'\)/, line);
  assert.match(routes, /'\/:id\/changes'.*requirePermission\('excel',\s*'update'\)/);
  assert.match(routes, /router\.delete\('\/:id'.*requirePermission\('excel',\s*'delete'\)/);
});

test('workbook lookups are tenant-scoped and site-checked in SQL, and invisible rows answer 404', async () => {
  const [model, controller] = await Promise.all([
    source('src/models/spreadsheet.model.js'),
    source('src/controllers/spreadsheet.controller.js'),
  ]);
  assert.match(model, /WHERE w\.id = \$1 AND w\.organization_id = \$4/);
  assert.match(model, /EXISTS \(SELECT 1 FROM user_sites us WHERE us\.user_id = \$2 AND us\.site_id = w\.site_id\)/);
  assert.match(model, /w\.organization_id = \$1/);
  assert.match(controller, /res\.status\(404\)\.json\(\{ message: 'Workbook not found' \}\)/);
  assert.match(controller, /resolveAccessLevel\(\{ user: req\.user, workbook, shareLevel: workbook\.share_level, siteOk: workbook\.site_ok, permission \}\)/);
  assert.match(controller, /assertComplianceSiteAccess\(req, res, rawSiteId, \{ required: true \}\)/);
});

test('write handlers require an editor/owner access level so a viewer share cannot PATCH', async () => {
  const controller = await source('src/controllers/spreadsheet.controller.js');
  const editorGuarded = ['saveChanges', 'createVersion', 'listVersions'];
  const ownerGuarded = ['deleteWorkbook', 'restoreWorkbook', 'restoreVersion', 'upsertShare', 'deleteShare'];
  for (const name of editorGuarded) {
    const body = controller.slice(controller.indexOf(`export const ${name} `));
    assert.match(body.slice(0, 600), /minimum: 'editor'/, `${name} must require editor`);
  }
  for (const name of ownerGuarded) {
    const body = controller.slice(controller.indexOf(`export const ${name} `));
    assert.match(body.slice(0, 600), /minimum: 'owner'/, `${name} must require owner`);
  }
  assert.match(controller, /const force = body\.force === true && hasLevel\(access\.level, 'editor'\)/);
});

test('autosave uses optimistic locking and refuses structural ops without snapshots', async () => {
  const [model, ops] = await Promise.all([
    source('src/models/spreadsheet.model.js'),
    source('src/utils/spreadsheetOps.js'),
  ]);
  assert.match(model, /FOR UPDATE/);
  assert.match(model, /baseVersion !== current\.version/);
  assert.match(model, /err\.serverVersion = current\.version/);
  assert.match(ops, /Structural changes must be sent as sheet snapshots/);
  assert.match(ops, /__proto__/);
});

test('migration carries tenant keys, indexes, version and soft-delete columns', async () => {
  const migration = await source('src/migrations/139_spreadsheet_workbooks.js');
  assert.match(migration, /organization_id INTEGER NOT NULL DEFAULT 1 REFERENCES organizations\(id\)/);
  assert.match(migration, /site_id INTEGER REFERENCES sites\(id\)/);
  assert.match(migration, /version INTEGER NOT NULL DEFAULT 1/);
  assert.match(migration, /deleted_at TIMESTAMPTZ/);
  assert.match(migration, /idx_ss_workbooks_org_site ON spreadsheet_workbooks \(organization_id, site_id/);
  assert.match(migration, /idx_ss_workbooks_org_id ON spreadsheet_workbooks \(organization_id, id\)/);
  assert.match(migration, /UNIQUE \(workbook_id, sheet_key\)/);
  assert.match(migration, /access_level IN \('editor', 'commenter', 'viewer'\)/);
});

test('business events are audited explicitly and per-keystroke HTTP audit rows are suppressed', async () => {
  const [controller, audit] = await Promise.all([
    source('src/controllers/spreadsheet.controller.js'),
    source('src/middlewares/audit.middleware.js'),
  ]);
  for (const action of ['WORKBOOK_CREATED', 'WORKBOOK_RENAMED', 'WORKBOOK_IMPORTED', 'WORKBOOK_EXPORTED', 'WORKBOOK_DELETED', 'WORKBOOK_RESTORED', 'PERMISSION_CHANGED', 'VERSION_RESTORED']) {
    assert.match(controller, new RegExp(`action: '${action}'`), action);
  }
  assert.match(controller, /CLIENT_EVENTS = new Set\(\['SHEET_CREATED', 'SHEET_DELETED', 'SHEET_RENAMED', 'WORKBOOK_RENAMED'\]\)/);
  assert.match(audit, /segments\[0\] === 'spreadsheets' && \['changes', 'export'\]\.includes\(segments\[2\]\)/);
  assert.match(audit, /spreadsheets: 'excel'/);
});

test('upload/import payloads are size-limited, decompressed safely and structurally validated', async () => {
  const [controller, ops] = await Promise.all([
    source('src/controllers/spreadsheet.controller.js'),
    source('src/utils/spreadsheetOps.js'),
  ]);
  assert.match(controller, /express\.raw\(\{ type: 'application\/octet-stream', limit: '200mb' \}\)/);
  assert.match(controller, /The compressed payload could not be read/);
  assert.match(controller, /validateSheetList\(body\.sheets\)/);
  assert.match(ops, /MAX_CELLS_PER_SHEET = 2_000_000/);
  assert.match(ops, /MAX_SHEETS = 200/);
});
