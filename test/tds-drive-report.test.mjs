import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { readFile } from 'node:fs/promises';
import { readTdsRegister } from '../src/services/tdsRegister.service.js';
import { filterTdsDriveRows, loadTdsDriveSheets, normalizeModuleDriveFilters } from '../src/services/tdsDriveReport.service.js';
import { enrichTdsDriveSources } from '../src/services/tdsDriveSources.service.js';
import { buildModuleShareXlsx, renderModuleShareHtml, moduleShareProjection } from '../src/services/driveShareWorkbook.service.js';
import { transactionParticularsText } from '../src/services/transactionDisplay.service.js';

const deduction = (id, overrides = {}) => ({ id, source_module: 'expense', source_table: 'expenses', source_id: id,
  source_label: `expense #${id}`, source_details: { payment_mode: 'RTGS' }, deduction_date: '2026-10-05',
  deductee_name: 'Person One', pan: 'ABCDE1234F', aadhaar: '123456789012', section: 'OTHER',
  gross_amount: '100000', tds_amount: '2000', net_amount: '98000', tds_rate: '2', calculation_mode: 'percentage',
  payment_mode: 'RTGS', transaction_id: `REF-${id}`, created_by_name: 'Operator', created_at: '2026-10-05T08:00:00Z',
  payment_state: 'active', due_date: '2026-11-07', notes: `Note ${id}`, ...overrides });
const position = { deducted: '6000', deposited: '2000', payable: '4000', with_ca: '1000', overdue: '500', pending: '200', legacy_deposited: '0' };

test('Drive reads the same complete TDS register projection, with every field and every matching row in Excel', async () => {
  const records = Array.from({ length: 251 }, (_, index) => deduction(index + 1, { ca_name: 'CA One', ca_transfer_id: 4,
    ca_transfer_date: '2026-10-06', settlement_entry_id: 40, settlement_reference: 'SET-40' }));
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM tds_deductions t')) return { rows: records };
    if (sql.startsWith('WITH deductions')) return { rows: [position] };
    if (sql.includes('jsonb_to_recordset')) return { rows: records.map(row => ({ source_key: 'expenses', source_id: row.id,
      particular: 'RTGS payout', remarks: 'Approved bill', voucher_url: `private/${row.id}.pdf` })) };
    return { rows: records.map(row => ({ source_key: 'expenses', source_id: row.id, party_name: 'Party One', category: 'Legal fees', linked_client_name: 'Client One' })) };
  } };
  const filters = normalizeModuleDriveFilters('tds', { date_from: '2026-10-01', date_to: '2026-10-31', search: 'Person One', sort: 'date_asc' });
  const apiRows = await readTdsRegister(2, { from: filters.date_from, to: filters.date_to }, db);
  const loaded = await loadTdsDriveSheets(2, filters, db, { id: 8, role: 'admin' });
  const register = loaded[0];
  assert.equal(apiRows.length, 251); assert.equal(register.rows.length, 251);
  assert.deepEqual(register.rows.map(row => row.id), apiRows.map(row => row.id));
  for (const call of calls.filter(call => call.sql.includes('FROM tds_deductions t'))) {
    assert.deepEqual(call.values, [2, '2026-10-01', '2026-10-31']); assert.doesNotMatch(call.sql, /LIMIT/);
  }
  const bundle = { moduleLabel: 'TDS Register', label: 'Site A — TDS Register', viewFilters: filters,
    sheets: loaded.map(({ definition, rows }) => ({ ...definition, rows })), summary: { record_count: 251 }, documents: [] };
  const workbook = XLSX.read(buildModuleShareXlsx(bundle), { type: 'buffer' });
  const data = XLSX.utils.sheet_to_json(workbook.Sheets['TDS Register'], { header: 1, raw: true });
  assert.equal(data.length - 4, 251);
  const at = (label, row = 4) => data[row][data[3].indexOf(label)];
  assert.equal(at('Payment party / person'), 'Party One'); assert.equal(at('Payment category'), 'Legal fees');
  assert.equal(at('Module'), 'Expenses'); assert.equal(at('Linked client'), 'Client One');
  assert.equal(at('Aadhaar'), '123456789012'); assert.equal(at('Net paid'), 98000);
  assert.equal(at('CA name'), 'CA One'); assert.equal(at('Settlement reference'), 'SET-40');
  assert.equal(at('Created by'), 'Operator'); assert.equal(at('Notes', 254), 'Note 251');
  assert.equal(at('Status'), 'Due'); assert.match(at('Payment particulars'), /RTGS payout/);
  assert.equal(loaded[1].rows[0].records, 251); assert.equal(loaded[1].rows[0].tds, 502000);
  assert.equal(loaded[2].rows[0].reserve, 3000);
  const html = renderModuleShareHtml(bundle);
  assert.match(html, /Showing 100 of 251/); assert.match(html, /Excel includes all 251/); assert.match(html, /overflow-x:auto/);
  assert.notDeepEqual(moduleShareProjection(bundle), moduleShareProjection({ ...bundle, viewFilters: { ...filters, status: 'deposited' } }));
});

test('TDS filter combinations match the module across financial years, status, names, KYC, mode, quarter, amounts and sorting', () => {
  const rows = [deduction(1), deduction(2, { pan: '', deductee_name: 'Person Two', payment_mode: 'CASH', payment_state: 'pending' }),
    deduction(3, { source_module: 'plot_commission', section: '194H', calculation_mode: 'manual', tds_amount: '3000', gross_amount: '150000', deposit_date: '2026-10-07' }),
    deduction(4, { deduction_date: '2025-02-01', due_date: '2025-03-07' }), deduction(5, { payment_state: 'reversed' })];
  const ids = filters => filterTdsDriveRows(rows, filters, '2026-10-10').map(row => row.id);
  assert.deepEqual(ids({ date_from: '2026-10-01', date_to: '2026-10-31', status: 'due' }), [1]);
  assert.deepEqual(ids({ pan: 'missing', deductee: 'Person Two', payment_mode: 'CASH', status: 'pending' }), [2]);
  assert.deepEqual(ids({ source_module: 'plot_commission', section: '194H', calculation_mode: 'manual', quarter: '3', min_tds: '3000', max_tds: '3000' }), [3]);
  assert.deepEqual(ids({ status: 'overdue', quarter: '4' }), [4]);
  assert.deepEqual(ids({ search: '1234 5678 9012', status: 'reversed' }), [5]);
  assert.deepEqual(ids({ search: 'Project commission' }), [3]);
  assert.equal(ids({ sort: 'tds_desc' })[0], 3);
  for (const invalid of ['{', [], { creatorId: 99 }, { date_from: '2026-02-30' }, { min_tds: '-1' }, { status: 'not-a-status' }]) {
    assert.throws(() => normalizeModuleDriveFilters('tds', invalid), { statusCode: 400 });
  }
  assert.throws(() => normalizeModuleDriveFilters('expenses', { source: 'secret' }), { statusCode: 400 });
});

test('source payment evidence respects Day Book and native-module read access before looking up creators or documents', async () => {
  const rows = [deduction(1), deduction(2, { source_module: 'vendor_payment', source_table: 'vendor_payments' })];
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('user_permissions')) return { rows: [{ module: 'daybook', can_read: true, can_view_all: false }, { module: 'expenses', can_read: true }] };
    if (sql.includes('jsonb_to_recordset')) return { rows: [{ source_key: 'expenses', source_id: 1, voucher_url: 'own.pdf' }] };
    return { rows: [{ source_key: 'expenses', source_id: 1, party_name: 'Own party', category: 'Office' }] };
  } };
  const result = await enrichTdsDriveSources(rows, { siteId: 2, user: { id: 8, role: 'sub_admin' } }, db);
  const lookup = calls.find(call => call.sql.includes('jsonb_to_recordset'));
  assert.deepEqual(lookup.values, [2, JSON.stringify([{ source_key: 'expenses', source_id: 1 }]), 8]);
  assert.match(lookup.sql, /c.site_id=\$1/); assert.match(lookup.sql, /c.created_by=\$3/);
  assert.equal(result[0].voucher_url, 'own.pdf'); assert.equal(result[1].source_context, undefined);
  let queries = 0;
  const withoutAccess = await enrichTdsDriveSources(rows, { siteId: 2, user: { id: 8, role: 'sub_admin' } }, { query: async () => { queries++; return { rows: [] }; } });
  assert.equal(queries, 1); assert.strictEqual(withoutAccess, rows);
});

test('Drive particulars follow the frontend display contract without repeating the person or losing categories', async () => {
  const frontend = await readFile(new URL('../../rgaccount/src/lib/transactionParticulars.js', import.meta.url), 'utf8').catch(() => null);
  if (frontend) {
    const backend = await readFile(new URL('../src/services/transactionDisplay.service.js', import.meta.url), 'utf8');
    assert.equal(backend.slice(backend.indexOf('const SOURCES')), frontend.slice(frontend.indexOf('const SOURCES')));
  }
  const text = transactionParticularsText({ source_key: 'personal_ledger', party_name: 'BALAJI ASSOCIATES', ledger_name: 'BALAJI ASSOCIATES', ledger_type: 'person',
    particular: 'RTGS', linked_detail: 'Person ledger · BALAJI ASSOCIATES' });
  assert.equal(text, 'BALAJI ASSOCIATES · Category: Person · Module: Personal Ledger · RTGS');
});

test('native source lookup includes only the permitted creator in the selected site, including actual party and bank details', async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE TABLE user_permissions(user_id int,module text,can_read boolean,can_view_all boolean);
    CREATE TABLE cash_flow_entries(id int,site_id int,source_module text,source_id int,particular text,remarks text,voucher_url text,bank_account_id int,created_by int);
    CREATE TABLE bank_accounts(id int,site_id int,name text);
    CREATE TABLE expenses(id int,site_id int,debit numeric,credit numeric,to_entity text,from_entity text,category text,sub_category text);
    CREATE TABLE members(id int,full_name text);
    CREATE TABLE transaction_party_links(source_key text,source_id int,site_id int,member_id int);
    INSERT INTO user_permissions VALUES(7,'daybook',true,false),(7,'expenses',true,false);
    INSERT INTO bank_accounts VALUES(1,1,'Own bank');
    INSERT INTO cash_flow_entries VALUES(1,1,'expenses',101,'RTGS payout','Own note','own.pdf',1,7),
      (2,1,'expenses',102,'Other payout','Other note','other.pdf',1,8),
      (3,2,'expenses',201,'Foreign payout','Foreign note','foreign.pdf',1,7);
    INSERT INTO expenses VALUES(101,1,98000,0,'Party One','Site','Legal fees','Stamp duty'),
      (102,1,98000,0,'Other party','Site','Other',NULL),(201,2,98000,0,'Foreign party','Site','Other',NULL);
    INSERT INTO members VALUES(1,'Client One'),(2,'Foreign client');
    INSERT INTO transaction_party_links VALUES('expense',101,1,1),('expense',101,2,2);
  `);
  const rows = await enrichTdsDriveSources([deduction(101),deduction(102),deduction(201)], { siteId: 1, user: { id: 7, role: 'sub_admin' } }, db);
  assert.equal(rows[0].source_context.party_name, 'Party One'); assert.equal(rows[0].source_context.category, 'Legal fees');
  assert.equal(rows[0].source_context.sub_category, 'Stamp duty'); assert.equal(rows[0].source_context.linked_client_name, 'Client One');
  assert.equal(rows[0].source_context.bank_account_name, 'Own bank'); assert.equal(rows[0].voucher_url, 'own.pdf');
  assert.equal(rows[1].source_context, undefined); assert.equal(rows[2].source_context, undefined);
});
