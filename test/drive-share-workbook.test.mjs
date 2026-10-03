import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { buildModuleShareXlsx, renderModuleShareHtml, moduleShareProjection } from '../src/services/driveShareWorkbook.service.js';
import { buildStatementXlsx, planShareFiles, plotShareDocumentSources } from '../src/services/plotCommissionShare.service.js';

const sample = () => ({
  moduleKey: 'expenses', moduleLabel: 'Expenses', siteId: 2, entityId: 31, entityType: 'expense', scope: 'overall',
  label: 'Garden site expenses', generatedAt: new Date('2026-10-03T06:00:00Z'), summary: { record_count: 2, document_count: 1 },
  sheets: [{ name: 'Expense / detail', columns: [
    { key: 'date', label: 'Date', type: 'date' }, { key: 'name', label: 'Supplier', type: 'text' },
    { key: 'amount', label: 'Amount (INR)', type: 'money' }, { key: 'account', label: 'Account', type: 'text' },
  ], rows: [{ date: '2026-10-03', name: '=HYPERLINK("https://evil.test")', amount: 12345.67, account: '001234567890' },
    { date: '2026-10-02', name: 'Supplier <script>alert(1)</script>', amount: -25, account: '0000042' }] }],
  documents: [{ id: 9, name: 'Original bill.pdf', sourceModule: 'expenses', sourceId: 31, sourceFingerprint: 'source-hash', linkVersion: 'access-hash',
    url: 'https://api.example.test/public/drive-documents/encryptedToken_123' }],
});
const xml = (bytes, path) => Buffer.from(XLSX.CFB.find(XLSX.CFB.read(bytes, { type: 'buffer' }), `Root Entry/${path}`).content).toString();

test('workbook retains numeric money, real dates, literal text, filters, widths and secure document hyperlinks', () => {
  const bytes = buildModuleShareXlsx(sample());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const workbook = XLSX.read(bytes, { type: 'buffer', cellNF: true, cellStyles: true });
  assert.deepEqual(workbook.SheetNames, ['Summary', 'Expense detail', 'Documents']);
  const sheet = workbook.Sheets[workbook.SheetNames[1]];
  assert.equal(sheet.C5.t, 'n');
  assert.equal(sheet.C5.v, 12345.67);
  assert.match(sheet.C5.z, /₹/);
  assert.equal(sheet.A5.t, 'n');
  assert.equal(sheet.A5.z, 'dd mmm yyyy');
  assert.equal(sheet.D5.t, 's');
  assert.equal(sheet.D5.v, '001234567890');
  assert.equal(sheet.B5.f, undefined, 'untrusted labels must remain text, never executable formulas');
  assert.equal(sheet.B5.t, 's');
  assert.equal(sheet['!autofilter'].ref, 'A4:D6');
  assert.ok(sheet['!cols'][0].wch >= 17);
  assert.equal(workbook.Sheets.Documents.D2.l.Target, sample().documents[0].url);
  const sheetXml = xml(bytes, 'xl/worksheets/sheet2.xml');
  assert.match(sheetXml, /<pane ySplit="4"[^>]*state="frozen"/);
  assert.match(sheetXml, /showGridLines="0"/);
  const stylesXml = xml(bytes, 'xl/styles.xml');
  assert.match(stylesXml, /FF17324D/);
  assert.match(stylesXml, /FFF1F5F9/);
  assert.match(stylesXml, /<b\/>/);
  assert.match(sheetXml, /<c r="A4"[^>]*s="[1-9]\d*"/);
});

test('large workbooks retain every row while previews stay bounded and disclose the limit', () => {
  const bundle = sample();
  bundle.sheets[0].rows = Array.from({ length: 250 }, (_, i) => ({ date: '2026-10-03', name: `Unique row ${i}`, amount: i, account: `0${i}` }));
  const bytes = buildModuleShareXlsx(bundle);
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[1]], { header: 1 }).length, 254);
  const html = renderModuleShareHtml(bundle);
  assert.match(html, /Showing 100 of 250 rows\. Excel includes all 250\./);
  assert.match(html, /Unique row 99/);
  assert.doesNotMatch(html, /Unique row 100/);
  const fullHtml = renderModuleShareHtml(bundle, { preview: false });
  assert.match(fullHtml, /Unique row 249/);
  assert.doesNotMatch(fullHtml, /Showing 100/);
  const uncompressed = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: false });
  assert.ok(bytes.length < uncompressed.length * 0.7, 'cloud upload should use ZIP compression');
});

test('datetime columns retain the time in IST as a sortable Excel numeric value', () => {
  const bundle = sample();
  bundle.sheets = [{ name: 'Audit dates', columns: [{ key: 'created_at', label: 'Created at (IST)', type: 'datetime' }],
    rows: [{ created_at: '2026-10-03T06:15:00Z' }] }];
  const workbook = XLSX.read(buildModuleShareXlsx(bundle), { type: 'buffer', cellNF: true });
  const cell = workbook.Sheets['Audit dates'].A5;
  assert.equal(cell.t, 'n');
  assert.equal(cell.z, 'dd mmm yyyy hh:mm');
  const date = XLSX.SSF.parse_date_code(cell.v);
  assert.deepEqual([date.y, date.m, date.d, date.H, date.M], [2026, 10, 3, 11, 45]);
  assert.match(renderModuleShareHtml(bundle), /11:45 IST/);
});

test('HTML escapes all source content and never embeds raw private or expired S3 URLs', () => {
  const bundle = sample();
  bundle.documents.push({ id: 8, name: '<img src=x onerror=alert(1)>', url: 'https://bucket.s3.ap-south-1.amazonaws.com/private?X-Amz-Signature=expired' });
  const html = renderModuleShareHtml(bundle);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<img|X-Amz|bucket\.s3/);
  assert.match(html, /Open original document/);
  const workbook = XLSX.read(buildModuleShareXlsx(bundle), { type: 'buffer' });
  assert.equal(workbook.Sheets.Documents.D3?.l, undefined);
  assert.equal(workbook.Sheets.Documents.E3.v, 'Link unavailable');
});

test('semantic projection ignores regenerated tokens and timestamps but changes for source data and access revisions', () => {
  const first = sample();
  const second = sample();
  second.generatedAt = new Date('2027-10-03');
  second.documents[0].url = 'https://api.example.test/public/drive-documents/differentRandomToken';
  assert.deepEqual(moduleShareProjection(first), moduleShareProjection(second));
  second.documents[0].linkVersion = 'new-access';
  assert.notDeepEqual(moduleShareProjection(first), moduleShareProjection(second));
  second.documents[0].linkVersion = first.documents[0].linkVersion;
  second.sheets[0].rows[0].amount += 1;
  assert.notDeepEqual(moduleShareProjection(first), moduleShareProjection(second));
});

test('plot document links scope produces a compact document index without financial data or binary copy tasks', () => {
  const bundle = { scope: 'documents', plot: { id: 1, plot_no: 'A1' }, site: { name: 'Garden' }, agents: [], allPayments: [], totals: {},
    documents: [{ id: 8, title: 'Agreement', file_path: 'documents/a.pdf', original_name: 'agreement.pdf' }], vouchers: [], signatures: [],
    generatedAt: new Date('2026-10-03'), documentLinks: sample().documents };
  const plan = planShareFiles(bundle, { documentMode: 'links', includeDocuments: false });
  assert.deepEqual(plan.map((item) => [item.kind, item.formats]), [['statement', ['xlsx']]]);
  const workbook = XLSX.read(buildStatementXlsx(bundle), { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Summary', 'Documents']);
  assert.equal(workbook.Sheets.Documents.D2.l.Target, sample().documents[0].url);
  assert.equal(plotShareDocumentSources(bundle)[0].url, 'documents/a.pdf');
});
