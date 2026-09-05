import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readBackend = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readFrontend = (path) => readFile(new URL(`../../rgaccount/${path}`, import.meta.url), 'utf8');

test('only uncommitted site cash can be distributed and Admin float is retired', async () => {
  const kpi = await readBackend('src/graphql/services/kpi.service.js');
  const controller = await readBackend('src/controllers/imprest.controller.js');
  const model = await readBackend('src/models/Imprest.model.js');

  assert.match(kpi, /ledger\.cash_balance - imprest\.imprest_held[\s\S]*?- pending\.pending_imprest_reservations AS distributable_balance/);
  assert.match(kpi, /0::numeric AS admin_imprest_reserved/);
  assert.doesNotMatch(kpi, /- imprest\.admin_imprest_reserved/);

  const allocation = controller.slice(
    controller.indexOf('export const createAllocation'),
    controller.indexOf('export const listAllocations'),
  );
  assert.match(allocation, /const escrowFromGiver = !giverIsAdmin/);
  assert.match(allocation, /const allocationPaymentMode = 'CASH'/);
  assert.match(allocation, /allocationAmount > distributable\.available \+ 0\.005/);
  assert.doesNotMatch(allocation, /overrideReasonOf|isSelfDraw/);
  assert.match(model, /WHERE u\.role = 'sub_admin'/);
});

test('money received by an Admin returns to site custody without a personal ledger credit', async () => {
  const controller = await readBackend('src/controllers/imprest.controller.js');
  const confirm = controller.slice(
    controller.indexOf('export const confirmReceipt'),
    controller.indexOf('export const getBalance'),
  );
  const transfer = controller.slice(
    controller.indexOf('export const createTransfer'),
    controller.indexOf('export const listTransfers'),
  );

  assert.match(confirm, /const recipientIsAdmin = ADMIN_ROLES\.has\(req\.user\.role\)/);
  assert.match(confirm, /if \(!recipientIsAdmin\)[\s\S]*?type: fundedByGiverFloat \? 'TRANSFER_IN' : 'ALLOCATION'/);
  assert.match(confirm, /cash returned to the Site Balance/i);
  assert.match(transfer, /if \(!recipientIsAdmin\)[\s\S]*?type:\s*'TRANSFER_IN'/);
  assert.match(transfer, /recipientIsAdmin[\s\S]*?Funds returned to the Site Balance/);
});

test('universal source debits skip Admin personal imprest and retirement migration is deployed', async () => {
  const universal = await readBackend('src/migrations/125_universal_imprest_enforcement.js');
  const retirement = await readBackend('src/migrations/126_cash_only_admin_imprest.js');
  const pkg = JSON.parse(await readBackend('package.json'));

  assert.match(universal, /v_user_role IN \('admin', 'super_admin'\)[\s\S]*?v_required := 0[\s\S]*?v_wants_posted := FALSE/);
  assert.match(universal, /Source edits\/deletes can restore a legacy Admin-owned debit[\s\S]*?'admin_float_retirement'/);
  assert.match(retirement, /DELETE FROM imprest_debit_reservations/);
  assert.doesNotMatch(retirement, /SELECT reconcile_imprest_debit/);
  assert.match(retirement, /source_module[\s\S]*?'admin_float_retirement'/);
  assert.match(retirement, /ADMIN PERSONAL FLOAT RETIRED/);
  assert.equal(pkg.scripts['migrate:cash-only-admin-imprest'], 'node src/migrations/126_cash_only_admin_imprest.js');
  assert.match(pkg.scripts.start, /npm run migrate:cash-only-admin-imprest/);
  assert.match(pkg.scripts.migrate, /npm run migrate:cash-only-admin-imprest/);
});

test('Imprest screens show cash-only distribution and no Admin self-draw', async () => {
  const dashboard = await readFrontend('src/pages/ImprestDashboard.jsx');
  const management = await readFrontend('src/pages/ImprestManagement.jsx');
  const ui = await readFrontend('src/components/imprest/ui.jsx');

  assert.match(dashboard, /displayedFloatBalance = adminUsesSiteBalance \? num\(site\?\.available\)/);
  assert.match(dashboard, /Cash available for imprest/);
  assert.match(dashboard, /Cash available to distribute/);
  assert.doesNotMatch(dashboard, /site\?\.site_balance|bank_balance|Bank · not distributable|modes=\{\['CASH', 'BANK'/);
  assert.doesNotMatch(dashboard, /Myself — draw|giveSelfDraw|override_reason/);
  assert.match(management, /CASH ONLY/);
  assert.doesNotMatch(management, /Myself — draw|value="self"/);
  assert.doesNotMatch(ui, /site\.site_balance|site\.bank_balance|Bank · not distributable/);
  assert.match(ui, /\['Staff imprest', money\(staffFloat\), '−'\]/);
  assert.doesNotMatch(ui, /label="Admin float"|\['Admin float'/);
});
