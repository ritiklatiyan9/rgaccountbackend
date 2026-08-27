import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('Plot Payments is the primary NOC workspace', () => {
  const app = read('../../rgaccount/src/App.jsx');
  const detail = read('../../rgaccount/src/pages/PlotDetail.jsx');
  const workspace = read('../../rgaccount/src/pages/PlotPaymentNoc.jsx');

  assert.match(app, /path="\/plot-payments\/:plotId\/noc"/);
  assert.match(app, /path="\/plot-payments\/:plotId\/noc\/print\/:registryId"/);
  assert.match(detail, /navigate\(`\/plot-payments\/\$\{id\}\/noc`\)/);
  assert.match(workspace, /api\.get\(`\/plots\/\$\{plotId\}\/registry-noc`\)/);
  assert.match(workspace, /api\.get\('\/registries'/);
  assert.match(workspace, /matchesPlot/);
  assert.match(workspace, /api\.post\('\/registries'/);
  assert.match(workspace, /canIncludeInNoc/);
  assert.match(workspace, /api\.post\(`\/plots\/\$\{plotId\}\/noc-workspace`\)/);
  assert.match(workspace, /workspace="plot-payments"/);
  const nocEditor = read('../../rgaccount/src/pages/PlotRegistryNoc.jsx');
  assert.match(nocEditor, /\/noc\/approve/);
  assert.match(nocEditor, /plotAlreadyRegistry/);
});

test('NOC resolution and NOC data routes authorize Plot Payments users', () => {
  const plotRoutes = read('../src/routes/plot.routes.js');
  const registryRoutes = read('../src/routes/registry.routes.js');
  const controller = read('../src/controllers/plot.controller.js');
  const registryController = read('../src/controllers/registry.controller.js');

  assert.match(plotRoutes, /router\.post\('\/:id\/noc-workspace'.*createPlotNocRegistry\)/);
  assert.match(controller, /export const createPlotNocRegistry/);
  assert.match(controller, /NOC workspace draft created automatically from Plot Payments/);
  assert.match(controller, /FOR UPDATE/);
  assert.match(registryController, /SET status = 'REGISTRY', updated_at = NOW\(\)/);
  assert.match(registryController, /payload\.registry_deed_unlocked/);
  assert.match(registryRoutes, /requireAnyPermission\(\['plot_registry', 'plot_payments'\], 'read'\)/);
  assert.match(registryRoutes, /requireAnyPermission\(\['plot_registry', 'plot_payments'\], 'update'\)/);
});

test('Registry deed upload becomes an emerald ready state after NOC generation', () => {
  const documents = read('../../rgaccount/src/components/RegistryDocuments.jsx');
  const registry = read('../../rgaccount/src/pages/PlotRegistry.jsx');

  assert.match(documents, /NOC generated — the registry deed can now be uploaded/);
  assert.match(documents, /registryDeedReady/);
  assert.match(documents, /border-emerald-200/);
  assert.match(registry, /NOC in Plot Payments/);
  assert.match(registry, /NOC → Registry/);
});

test('NOC issuance keeps a permanent REF and appends immutable ACK revisions', () => {
  const migration = read('../src/migrations/105_plot_noc_revision_history.js');
  const controller = read('../src/controllers/registry.controller.js');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS plot_registry_noc_history/);
  assert.match(migration, /UNIQUE \(registry_id, revision_no\)/);
  assert.match(migration, /prevent_plot_registry_noc_history_mutation/);
  assert.match(migration, /Imported from the NOC issued before revision history was enabled/);
  assert.match(controller, /code: 'NOC_REF_IMMUTABLE'/);
  assert.match(controller, /ACK\/NOC\/\$\{String\(registryId\)\.padStart\(4, '0'\)\}\/R/);
  assert.match(controller, /code: 'NOC_REVISION_REASON_REQUIRED'/);
  assert.match(controller, /INSERT INTO plot_registry_noc_history/);
  assert.match(controller, /SELECT \* FROM plot_registries WHERE id = \$1 FOR UPDATE/);
});

test('NOC workspace controls payment visibility and the print follows the issued revision', () => {
  const editor = read('../../rgaccount/src/pages/PlotRegistryNoc.jsx');
  const print = read('../../rgaccount/src/pages/PlotRegistryNocPrint.jsx');

  assert.match(editor, /Show payment breakdown on the NOC/);
  assert.match(editor, /Select all eligible/);
  assert.match(editor, /Regenerate · New ACK/);
  assert.match(editor, /Reason for regeneration/);
  assert.match(editor, /Generation History/);
  assert.match(editor, /disabled=\{!canUpdate \|\| Boolean\(registry\.noc_generated_at\)\}/);
  assert.match(print, /const showPayments = registry\?\.noc_show_payments !== false/);
  assert.match(print, /REF No\.:/);
  assert.match(print, /ACK No\.:/);
  assert.match(print, /\{showPayments && \(/);
  assert.match(print, /String\(p\.cheque_status \|\| ''\)\.toUpperCase\(\) !== 'PENDING'/);
});
