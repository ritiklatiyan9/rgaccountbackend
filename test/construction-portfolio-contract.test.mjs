import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('construction portfolio migration supports mixed development hierarchies', async () => {
  const migration = await source('src/migrations/141_construction_portfolio_structure.js');

  for (const projectType of ['STUDIO_APARTMENTS', 'FLATS', 'PLOTTED_DEVELOPMENT', 'MIXED_USE']) {
    assert.ok(migration.includes(`'${projectType}'`), `missing project type ${projectType}`);
  }
  for (const locationType of ['TOWER', 'BLOCK', 'FLOOR', 'FLAT', 'STUDIO', 'PLOT', 'ZONE']) {
    assert.ok(migration.includes(`'${locationType}'`), `missing location type ${locationType}`);
  }
  assert.match(migration, /FOREIGN KEY \(parent_id, project_id\)[\s\S]*REFERENCES construction_locations\(id, project_id\)/);
  assert.match(migration, /construction_tasks_location_project_fk/);
  assert.match(migration, /vendor_commitments_location_project_fk/);
  assert.match(migration, /vendor_orders_location_project_fk/);
});

test('construction hierarchy and project operations are permission and site scoped', async () => {
  const [routes, controller] = await Promise.all([
    source('src/routes/construction.routes.js'),
    source('src/controllers/construction.controller.js'),
  ]);

  assert.match(routes, /projects\/:id\/locations\/bulk'[\s\S]*requirePermission\('construction', 'write'\)/);
  assert.match(routes, /locations\/:locationId'[\s\S]*requirePermission\('construction', 'update'\)/);
  assert.match(controller, /SELECT \* FROM construction_projects WHERE id = \$1 AND site_id = \$2/);
  assert.match(controller, /Parent location does not belong to this project/);
  assert.match(controller, /That parent would create a location cycle/);
});

test('material issue and consumption serialize stock mutations', async () => {
  const [construction, inventory] = await Promise.all([
    source('src/controllers/construction.controller.js'),
    source('src/controllers/inventory.controller.js'),
  ]);

  assert.match(construction, /ORDER BY material_id, id/);
  assert.ok((construction.match(/pg_advisory_xact_lock/g) || []).length >= 2);
  assert.match(inventory, /pg_advisory_xact_lock/);
  assert.match(inventory, /reduction > stock\.available/);
  assert.match(inventory, /type === 'UNRESERVE' && q > stock\.reserved/);
});

test('vendor work and purchase orders can be linked back to project locations', async () => {
  const [routes, vendors, orders, inventory] = await Promise.all([
    source('src/routes/vendor.routes.js'),
    source('src/controllers/vendor.controller.js'),
    source('src/controllers/vendorInventory.controller.js'),
    source('src/controllers/inventory.controller.js'),
  ]);

  assert.match(routes, /\/project-options'[\s\S]*requirePermission\('vendors', 'read'\)/);
  assert.match(vendors, /INSERT INTO vendor_commitments[\s\S]*project_id, location_id/);
  assert.match(orders, /material_request_id/);
  assert.match(inventory, /request_id: order\.material_request_id/);
});
