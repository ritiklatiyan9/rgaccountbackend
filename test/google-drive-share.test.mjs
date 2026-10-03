import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as XLSX from '@e965/xlsx';
import pool from '../src/config/db.js';
import { plotCommissionV2Model } from '../src/models/PlotCommissionV2.model.js';
import {
  MODULE_FOLDER, MODULE_KEY, esc, moneyINR, fmtDate, maskAadhaar, shareFolderSegments,
  renderStatementHtml, renderProfileHtml, renderDocumentsHtml, buildStatementXlsx, planShareFiles, readStoredFileBytes, buildPlotCommissionShareBundle,
} from '../src/services/plotCommissionShare.service.js';

const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

// Pure fixture shaped like buildPlotCommissionShareBundle's output; no DB, no Drive.
const payment = (overrides) => ({
  id: 1, date: '2026-09-01', amount: 50000, tds_amount: 2500, tds_rate: 5, tds_section: '194H', payment_mode: 'BANK',
  bank_name: 'HDFC', cheque_no: null, cheque_status: null, transaction_id: 'UTR1', status: 'approved', remarks: '',
  voucher_url: null, customer_signature_url: null, authority_signature_url: null, agent_name: 'Sandeep Malik', ...overrides,
});
const bundle = (overrides = {}) => ({
  scope: 'overall',
  plot: { plot_no: 'A1', block: 'A', plot_size: 200, plot_rate: 15000, sale_price: 3000000, buyer_name: 'Rahul Verma', booking_date: '2026-08-15', status: 'booked', commission_rate: 2, team: 'North' },
  site: { name: 'Defence Garden', city: 'Meerut', state: 'UP' },
  agents: [{
    commission_id: 7, agent_id: 3, agent_name: 'Sandeep Malik', phone: '9999999999', alt_phone: '', email: 'sandeep@example.com', address: 'Meerut',
    pan_no: 'ABCDE1234F', aadhaar_masked: maskAadhaar('1234 5678 9012'), bank_name: 'HDFC Bank', account_no: '001122334455', ifsc_code: 'HDFC0000123', branch: 'Civil Lines',
    team: 'North', license_number: 'RERA-1', commission_rate: '2', total_commission: 60000, total_paid: 52500, balance: 7500, status: 'Partial', remarks: '',
  }],
  allPayments: [
    payment({ id: 1, remarks: '<b>x</b>', voucher_url: 'https://aierpbytematrix.s3.ap-south-1.amazonaws.com/vouchers/v1.png' }),
    payment({ id: 2, date: '2026-09-10', amount: -5000, tds_amount: 0, payment_mode: 'CASH', bank_name: null, transaction_id: null, remarks: 'returned' }),
    payment({ id: 3, date: '2026-09-20', amount: 10000, tds_amount: 500, payment_mode: 'CHEQUE', cheque_no: '445566', cheque_status: 'PENDING', status: 'approved', voucher_url: 'https://aierpbytematrix.s3.ap-south-1.amazonaws.com/vouchers/v3.jpg' }),
  ],
  payment: null,
  documents: [
    { id: 11, title: 'Agreement', original_name: 'agreement.pdf', file_path: 'record_documents/a.pdf', mime_type: 'application/pdf', file_size: 1024 },
    { id: 12, title: 'Agreement', original_name: 'agreement.pdf', file_path: 'record_documents/b.pdf', mime_type: 'application/pdf', file_size: 2048 },
    { id: 13, title: 'Huge scan', original_name: 'scan.jpg', file_path: 'record_documents/c.jpg', mime_type: 'image/jpeg', file_size: 30 * 1024 * 1024 },
  ],
  vouchers: [
    { payment_id: 1, url: 'https://aierpbytematrix.s3.ap-south-1.amazonaws.com/vouchers/v1.png', name: 'Voucher CMN-1.png' },
    { payment_id: 3, url: 'https://aierpbytematrix.s3.ap-south-1.amazonaws.com/vouchers/v3.jpg', name: 'Voucher CMN-3.jpg' },
  ],
  signatures: [{ payment_id: 3, url: 'https://aierpbytematrix.s3.ap-south-1.amazonaws.com/signatures/s3.png', name: 'Signature - CMN-3 - Customer.png' }],
  label: 'Agent Sandeep Malik - Plot A1',
  siteFolderName: 'SHRI GANESH ASSOCIATES',
  folderSegments: ['03-10-2026', MODULE_FOLDER, 'Agent Sandeep Malik - Plot A1'],
  totals: { total_commission: 60000, total_paid: 47500, tds_total: 2500, balance: 12500, payment_count: 3 },
  generatedAt: new Date('2026-10-03T08:35:00Z'),
  generatedBy: 'Ritik',
  ...overrides,
});

test('constants and formatters', () => {
  assert.equal(MODULE_FOLDER, 'Project Commission');
  assert.equal(MODULE_KEY, 'plot_commission');
  assert.equal(esc(`<a href="x">O'Neil & co</a>`), '&lt;a href=&quot;x&quot;&gt;O&#39;Neil &amp; co&lt;/a&gt;');
  assert.equal(moneyINR(1234567.5), '12,34,567.50');
  assert.equal(fmtDate('2026-09-01'), '01-09-2026');
  assert.equal(fmtDate(new Date(2026, 8, 1)), '01-09-2026');
  assert.equal(maskAadhaar('1234 5678 9012'), 'XXXX XXXX 9012');
  assert.equal(maskAadhaar(''), '');
});

test('statement HTML carries plot, agent, totals and escapes remarks', () => {
  const html = renderStatementHtml(bundle());
  assert.match(html, /^<!doctype html><html><head><meta charset="utf-8"><title>/);
  assert.match(html, /Plot A1/);
  assert.match(html, /Sandeep Malik/);
  assert.match(html, /60,000\.00/);
  assert.match(html, /47,500\.00/);
  assert.match(html, /12,500\.00/);
  assert.match(html, /CMN-1/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
  // Totals count only posted rows: the pending cheque (CMN-3) is excluded, the credit row is subtracted.
  assert.match(html, /52,500\.00/); // gross of CMN-1 in the totals row
  assert.match(html, /5,000\.00/); // credit column
  assert.doesNotMatch(html, /Aadhaar/);
  assert.doesNotMatch(html, /<style|class=|:nth-child|display:flex/);
});

test('transaction scope renders a single row with the receipt title', () => {
  const b = bundle();
  const html = renderStatementHtml({ ...b, scope: 'transaction', payment: b.allPayments[1] });
  assert.match(html, /<title>Transaction CMN-2 - Plot A1<\/title>/);
  assert.match(html, /CMN-2/);
  assert.doesNotMatch(html, /CMN-1\b/);
  assert.doesNotMatch(html, /CMN-3/);
});

test('profile HTML shows contact, bank and PAN with Aadhaar masked', () => {
  const html = renderProfileHtml(bundle());
  assert.match(html, /HDFC Bank/);
  assert.match(html, /001122334455/);
  assert.match(html, /HDFC0000123/);
  assert.match(html, /ABCDE1234F/);
  assert.match(html, /XXXX XXXX 9012/);
  assert.doesNotMatch(html, /1234 5678 9012/);
  assert.match(html, /sandeep@example\.com/);
});

test('documents-only preview lists planned files and skipped reasons', () => {
  const b = bundle({ scope: 'documents' });
  const html = renderDocumentsHtml(b, planShareFiles(b, { scope: 'documents', formats: [], includeDocuments: true }));
  assert.match(html, /Agreement \(11\)\.pdf/);
  assert.match(html, /Larger than 25 MB/);
  assert.match(html, /Voucher CMN-1\.png/);
});

test('xlsx workbook has Summary, Transactions, Agents and Documents sheets', () => {
  const buf = buildStatementXlsx(bundle());
  assert.ok(Buffer.isBuffer(buf));
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['Summary', 'Transactions', 'Agents', 'Documents']);
  assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets.Documents, { header: 1 })[0], ['Document', 'Source', 'Record', 'Open document', 'Availability']);
  const tx = XLSX.utils.sheet_to_json(wb.Sheets.Transactions, { header: 1 });
  assert.equal(tx.length, 4);
  assert.equal(tx[1][1], 'CMN-1');
  assert.equal(tx[1][7], 52500); // gross = amount + tds
  assert.equal(tx[2][10], 5000); // credit column for the negative row
  assert.equal(tx[3][14], 'No'); // pending cheque is not posted
  const summary = Object.fromEntries(XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 }).filter((row) => row.length === 2));
  assert.equal(summary['Paid incl. TDS'], 47500);
  assert.equal(summary.Balance, 12500);
  const agents = XLSX.utils.sheet_to_json(wb.Sheets.Agents);
  assert.equal(agents[0]['Account no'], '001122334455'); // account identifiers keep leading zeroes
  assert.equal(agents[0]['Aadhaar (masked)'], 'XXXX XXXX 9012');
});

test('updating a plot workbook retains earlier transaction rows exactly once and includes the new payment', () => {
  const first = bundle();
  const next = bundle({
    allPayments: [...first.allPayments, payment({ id: 4, date: '2026-10-04', amount: 2000, tds_amount: 100 })],
    totals: { ...first.totals, total_paid: 49600, tds_total: 2600, balance: 10400, payment_count: 4 },
    generatedAt: new Date('2026-10-04T08:35:00Z'),
  });
  const rows = (data) => XLSX.utils.sheet_to_json(XLSX.read(buildStatementXlsx(data), { type: 'buffer' }).Sheets.Transactions, { header: 1 });
  const previous = rows(first);
  const updated = rows(next);
  assert.deepEqual(updated.slice(0, previous.length), previous);
  assert.deepEqual(updated.slice(1).map((row) => row[1]), ['CMN-1', 'CMN-2', 'CMN-3', 'CMN-4']);
  assert.equal(updated.at(-1)[7], 2100);
});

test('transaction workbook includes only the selected entry while preserving plot-wide summary', () => {
  const b = bundle();
  const wb = XLSX.read(buildStatementXlsx({ ...b, scope: 'transaction', payment: b.allPayments[1] }), { type: 'buffer' });
  const tx = XLSX.utils.sheet_to_json(wb.Sheets.Transactions);
  assert.equal(tx.length, 1);
  assert.equal(tx[0].Receipt, 'CMN-2');
  assert.equal(tx[0].Credit, 5000);
  assert.equal(tx[0].Posted, 'Yes');
  const summary = Object.fromEntries(XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 }).filter((row) => row.length === 2));
  assert.equal(summary['Decided commission'], 60000);
  assert.equal(summary['Paid incl. TDS'], 47500);
});

test('bundle can omit attachments without changing visible financial records or historical payments', async (t) => {
  const fixture = bundle();
  const calls = [];
  t.mock.method(plotCommissionV2Model, 'findAllCommissionsByPlotId', async (plotId, siteId) => {
    assert.equal(plotId, 20);
    assert.equal(siteId, 2);
    return [{ id: 7, agent_id: 3, agent_name: 'Sandeep Malik', plot_id: 20, site_id: 2, total_commission: 60000, plot_commission: 60000, ...fixture.plot }];
  });
  t.mock.method(pool, 'query', async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('SELECT pcp.*')) {
      assert.deepEqual(values, ['A1', 2, '8,9']);
      return { rows: [
        ...fixture.allPayments.map((p) => ({ ...p, plot_commission_id: 7 })),
        payment({ id: 4, date: '2026-08-01', amount: 1000, tds_amount: 0, plot_commission_id: 9 }),
      ] };
    }
    if (sql.includes('JSON_AGG')) {
      assert.deepEqual(values, ['A1', 2, '8,9']);
      return { rows: [
        { plot_id: 19, total_commission: 60000, total_paid_all: 1000, agents_detail: [{ commission_id: 9, agent_id: 4, agent_name: 'Previous Agent' }] },
        { plot_id: 20, total_commission: 60000, total_paid_all: 47500, agents_detail: [{ commission_id: 7, agent_id: 3, agent_name: 'Sandeep Malik' }] },
      ] };
    }
    if (sql.includes('FROM plots WHERE')) return { rows: [fixture.plot] };
    if (sql.includes('FROM sites WHERE')) return { rows: [fixture.site] };
    if (sql.includes('FROM members WHERE')) return { rows: [{ id: 3, ...fixture.agents[0], aadhar_no: '123456789012' }] };
    if (sql.includes('FROM users WHERE')) return { rows: [{ name: 'Ritik' }] };
    if (sql.includes('FROM documents')) return { rows: fixture.documents };
    if (sql.includes('FROM transaction_receipts')) return { rows: [{ record_id: '3', customer_signature_url: fixture.signatures[0].url }] };
    assert.fail(`Unexpected query: ${sql}`);
  });
  const args = { plotId: 20, siteId: 2, user: { id: 8 }, entryVisibility: { creatorId: '8,9' } };
  const fast = await buildPlotCommissionShareBundle({ ...args, includeDocuments: false });
  assert.ok(calls.every(({ sql }) => !/FROM (documents|transaction_receipts)\b/.test(sql)));
  assert.deepEqual([fast.documents, fast.vouchers, fast.signatures], [[], [], []]);
  assert.deepEqual(fast.allPayments.map((p) => [p.id, p.agent_name]), [[4, 'Previous Agent'], [1, 'Sandeep Malik'], [2, 'Sandeep Malik'], [3, 'Sandeep Malik']]);
  assert.deepEqual(fast.totals, { total_commission: 60000, total_paid: 48500, tds_total: 2500, balance: 11500, payment_count: 4 });

  const full = await buildPlotCommissionShareBundle(args);
  assert.deepEqual(full.allPayments, fast.allPayments);
  assert.deepEqual(full.agents, fast.agents);
  assert.deepEqual(full.totals, fast.totals);
  assert.equal(full.documents.length, 3);
  assert.equal(full.vouchers.length, 2);
  assert.equal(full.signatures.length, 1);

  const docsOnly = await buildPlotCommissionShareBundle({ ...args, scope: 'documents', includeDocuments: false });
  assert.equal(docsOnly.documents.length, 3);
  assert.equal(docsOnly.vouchers.length, 2);
  assert.equal(docsOnly.signatures.length, 1);

  const one = await buildPlotCommissionShareBundle({ ...args, scope: 'transaction', paymentId: 1, includeDocuments: false });
  assert.equal(one.payment.id, 1);
  assert.deepEqual(one.totals, full.totals);
  await assert.rejects(buildPlotCommissionShareBundle({ ...args, scope: 'transaction', paymentId: 999, includeDocuments: false }), { statusCode: 404 });
});

test('default share creates one Excel workbook without PDFs, Docs or attachments', () => {
  assert.deepEqual(planShareFiles(bundle()), [{
    folder: 'Transaction Details', name: 'Commission Statement - Plot A1', kind: 'statement', formats: ['xlsx'],
  }]);
  const docsOnly = planShareFiles(bundle({ scope: 'documents' }));
  assert.equal(docsOnly.length, 6);
  assert.ok(docsOnly.every((file) => file.folder === 'Documents'));
});

test('planShareFiles: overall scope with all formats', () => {
  const plan = planShareFiles(bundle(), { scope: 'overall', formats: ['doc', 'pdf', 'xlsx'], includeDocuments: true });
  const profile = plan.find((f) => f.kind === 'profile');
  const statement = plan.find((f) => f.kind === 'statement');
  assert.deepEqual([profile.folder, profile.name, profile.formats], ['User Details', 'Agent Profile - Sandeep Malik', ['doc', 'pdf']]);
  assert.deepEqual([statement.folder, statement.name, statement.formats], ['Transaction Details', 'Commission Statement - Plot A1', ['doc', 'pdf', 'xlsx']]);
  const docs = plan.filter((f) => f.folder === 'Documents');
  assert.deepEqual(docs.map((f) => f.name), ['Agreement (11).pdf', 'Agreement (12).pdf', 'Huge scan.jpg', 'Voucher CMN-1.png', 'Voucher CMN-3.jpg', 'Signature - CMN-3 - Customer.png']);
  assert.equal(docs[2].skipped_reason, 'Larger than 25 MB');
  assert.equal(docs[0].skipped_reason, undefined);
  assert.equal(docs[0].source, 'record_documents/a.pdf');
});

test('planShareFiles: format subsets and include_documents=false', () => {
  const plan = planShareFiles(bundle(), { scope: 'overall', formats: ['xlsx'], includeDocuments: false });
  assert.deepEqual(plan.map((f) => f.kind), ['statement']);
  assert.deepEqual(plan[0].formats, ['xlsx']);
  const pdfOnly = planShareFiles(bundle(), { scope: 'overall', formats: ['pdf'], includeDocuments: false });
  assert.deepEqual(pdfOnly.map((f) => [f.kind, f.formats]), [['profile', ['pdf']], ['statement', ['pdf']]]);
  const noAgent = planShareFiles(bundle({ agents: [] }), { scope: 'overall', formats: ['doc'], includeDocuments: false });
  assert.deepEqual(noAgent.map((f) => f.kind), ['statement']);
});

test('planShareFiles: documents scope has no statement; transaction scope only that payment\'s files', () => {
  const docsOnly = planShareFiles(bundle({ scope: 'documents' }), { scope: 'documents', formats: [], includeDocuments: true });
  assert.ok(docsOnly.every((f) => f.folder === 'Documents'));
  assert.equal(docsOnly.length, 6);

  const b = bundle();
  const tx = planShareFiles({ ...b, scope: 'transaction', payment: b.allPayments[0] }, { scope: 'transaction', formats: ['pdf'], includeDocuments: true });
  assert.deepEqual(tx.map((f) => f.name), ['Agent Profile - Sandeep Malik', 'Transaction CMN-1 - Plot A1', 'Voucher CMN-1.png']);
  assert.ok(tx.every((f) => f.kind !== 'document'));
});

test('readStoredFileBytes refuses URLs outside the configured buckets', async () => {
  await assert.rejects(readStoredFileBytes('https://evil.example/x'), (err) => err.code === 'UNSUPPORTED_STORAGE');
  await assert.rejects(readStoredFileBytes('https://169.254.169.254/latest/meta-data'), (err) => err.code === 'UNSUPPORTED_STORAGE');
});

test('security contract: routes and controller', async () => {
  const [routes, controller] = await Promise.all([
    source('src/routes/driveShare.routes.js'),
    source('src/controllers/driveShare.controller.js'),
  ]);
  assert.match(routes, /router\.use\(authMiddleware,\s*attachOrgContext,\s*requireRole\('admin',\s*'sub_admin'\)\)/);
  // Commission endpoints retain their gate; progress resolves the owning module dynamically.
  assert.equal((routes.match(/requirePermission\('commissions',\s*'read'\)/g) || []).length, 3);
  assert.match(controller, /assertModuleShareVisible\(req\.user, row\)/);
  assert.match(controller, /permission\?\.can_read !== true/);
  assert.match(controller, /resolveEntryVisibility\(req\.user,\s*'commissions'\)/);
  assert.doesNotMatch(controller, /created_by/);
  assert.match(controller, /SHARE_FULL_FORBIDDEN/);
  assert.match(controller, /assertCommissionSite\(req\.user,\s*siteId\)/);
  // The upload itself runs in the background job, which re-derives visibility
  // for the requesting user and serialises shares per plot.
  const jobs = await source('src/services/driveShareJobs.service.js');
  assert.match(jobs, /tryPlotShareLock\(orgId,\s*plotId\)/);
  assert.match(jobs, /resolveEntryVisibility\(user,\s*'commissions'\)/);
  assert.doesNotMatch(jobs, /created_by/);
  assert.match(jobs, /lock\.release\(\)/);
  // The request handler only queues: no Drive upload code may live in it.
  assert.doesNotMatch(controller, /upsertFile|exportPdf/);
  assert.match(controller, /status IN \('queued','running'\)/);
});

test('folders below the site folder are IST date, module and record', () => {
  const label = 'Agent Sandeep Malik - Plot A1';
  assert.deepEqual(shareFolderSegments({ label, date: new Date('2026-10-03T06:00:00Z') }), ['03-10-2026', 'Project Commission', label]);
  // 20:30 UTC is already the next day in India.
  assert.equal(shareFolderSegments({ label, date: new Date('2026-10-03T20:30:00Z') })[0], '04-10-2026');
});
