import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from '@e965/xlsx';
import { generatedContentHash, logicalFileKey, shareSyncSummary } from '../src/services/driveShareSync.js';
import { buildStatementXlsx, renderProfileHtml, renderStatementHtml } from '../src/services/plotCommissionShare.service.js';

const statement = { kind: 'statement', folder: 'Transaction Details', name: 'Commission Statement - Plot A1' };
const profile = { kind: 'profile', folder: 'User Details', name: 'Agent Profile - Agent One' };
const fixture = () => ({
  scope: 'overall', generatedAt: new Date('2026-10-03T05:00:00Z'), generatedBy: 'Admin One',
  folderSegments: ['03-10-2026', 'Project Commission', 'Agent One - Plot A1'], label: 'Agent One - Plot A1',
  site: { name: 'Defence Garden', city: 'Meerut', state: 'UP' },
  plot: { plot_no: 'A1', buyer_name: 'Buyer One', block: 'A', plot_size: 200, plot_size_mtr: 167, plot_rate: 15000, sale_price: 3000000, booking_date: '2026-09-01', status: 'booked', commission_rate: 2, team: 'North' },
  agents: [{ agent_name: 'Agent One', phone: '9000000000', pan_no: 'ABCDE1234F', bank_name: 'Bank', account_no: '0012345', ifsc_code: 'BANK0001', total_commission: 60000, total_paid: 10500, balance: 49500, email: 'agent@example.test', aadhaar_masked: 'XXXX XXXX 1234', branch: 'Meerut', status: 'partial', alt_phone: '9111111111', address: 'Meerut', team: 'North', license_number: 'RERA-1', commission_rate: 2, remarks: 'Primary agent' }],
  allPayments: [
    { id: 1, date: '2026-09-02', agent_name: 'Agent One', payment_mode: 'BANK', bank_name: 'Bank', transaction_id: 'UTR1', amount: 10000, tds_amount: 500, status: 'approved', remarks: 'First payment', tds_section: '194H', created_by_name: 'Admin', approved_by_name: 'Approver', voucher_url: 'https://bucket.test/voucher?signature=old', verifyUrl: 'https://verify.test/old' },
    { id: 2, date: '2026-09-03', agent_name: 'Agent One', payment_mode: 'CHEQUE', bank_name: 'Bank', cheque_no: '123', amount: 5000, tds_amount: 250, status: 'approved', cheque_status: 'PENDING', remarks: '' },
  ],
  payment: null,
  totals: { total_commission: 60000, total_paid: 10500, tds_total: 500, balance: 49500, payment_count: 2 },
  documents: [{ file_path: 'bucket/key', title: 'Proof' }],
  vouchers: [{ url: 'https://bucket.test/voucher?signature=old' }],
  signatures: [{ url: 'https://bucket.test/signature?signature=old' }],
});
const share = { organization_id: 3, site_id: 2, module: 'plot_commission', entity_type: 'plot', entity_id: 20, scope: 'overall', payment_id: null, shared_by: 8 };
const visibility = { canViewAll: true, creatorId: null };
const key = (overrides = {}) => logicalFileKey({ share, item: statement, format: 'xlsx', visibility, ...overrides });

test('generated content stays unchanged across new timestamps, uploader, folder and attachment URL changes', () => {
  const before = fixture();
  const after = fixture();
  after.generatedAt = new Date('2026-10-04T18:00:00Z');
  after.generatedBy = 'Another Admin';
  after.folderSegments = ['04-10-2026', 'Renamed Module', 'Renamed Folder'];
  after.label = 'Renamed Folder';
  after.documents = [{ file_path: 'different/key', title: 'New unrelated scan' }];
  after.vouchers[0].url = 'https://bucket.test/voucher?signature=new';
  after.signatures[0].url = 'https://bucket.test/signature?signature=new';
  after.allPayments[0].voucher_url = 'https://bucket.test/voucher?signature=new';
  after.allPayments[0].verifyUrl = 'https://verify.test/new';
  after.allPayments[0].customer_signature_url = 'https://bucket.test/new-signature';
  for (const [item, format] of [[statement, 'xlsx'], [statement, 'pdf'], [statement, 'doc'], [profile, 'pdf'], [profile, 'doc']]) {
    assert.equal(generatedContentHash(before, item, format), generatedContentHash(after, item, format));
  }
});

test('payment additions, corrections, deletions, approval/cheque changes and totals invalidate statement content', () => {
  const changes = [
    (b) => { b.allPayments.push({ ...b.allPayments[0], id: 3 }); },
    (b) => { b.allPayments[0].amount = 11000; },
    (b) => { b.allPayments[0].remarks = 'Corrected reference'; },
    (b) => { b.allPayments.shift(); },
    (b) => { b.allPayments[0].status = 'pending'; },
    (b) => { b.allPayments[1].cheque_status = 'CLEARED'; },
    (b) => { b.totals.balance = 48500; },
    (b) => { b.totals.total_commission = 70000; },
    (b) => { b.allPayments.reverse(); },
  ];
  for (const format of ['xlsx', 'pdf', 'doc']) {
    const original = generatedContentHash(fixture(), statement, format);
    for (const change of changes) {
      const changed = fixture();
      change(changed);
      assert.notEqual(generatedContentHash(changed, statement, format), original);
    }
  }
});

test('workbook includes bank identifiers and audit columns; profile hashes its additional contact fields', () => {
  const original = fixture();
  for (const change of [
    (b) => { b.agents[0].account_no = '0019999'; },
    (b) => { b.agents[0].aadhaar_masked = 'XXXX XXXX 9999'; },
    (b) => { b.allPayments[0].tds_section = '194C'; },
    (b) => { b.allPayments[0].approved_by_name = 'Another Approver'; },
  ]) {
    const changed = fixture();
    change(changed);
    assert.notEqual(generatedContentHash(changed, statement, 'xlsx'), generatedContentHash(original, statement, 'xlsx'));
  }
  const changed = fixture();
  changed.agents[0].address = 'New address';
  assert.notEqual(generatedContentHash(changed, profile, 'pdf'), generatedContentHash(original, profile, 'pdf'));
  assert.equal(generatedContentHash(changed, statement, 'xlsx'), generatedContentHash(original, statement, 'xlsx'), 'address is not an Excel column');
  changed.allPayments[0].remarks = 'A payment-only correction';
  assert.equal(generatedContentHash({ ...changed, agents: original.agents }, profile, 'pdf'), generatedContentHash(original, profile, 'pdf'), 'profile contains agent aggregates, not payment rows');
});

test('transaction content uses only its selected payment but retains displayed plot-wide totals', () => {
  const original = fixture();
  original.scope = 'transaction';
  original.payment = original.allPayments[0];
  const changed = structuredClone(original);
  changed.allPayments[1].remarks = 'Not displayed in this transaction';
  assert.equal(generatedContentHash(changed, statement, 'xlsx'), generatedContentHash(original, statement, 'xlsx'));
  changed.payment.remarks = 'Displayed correction';
  assert.notEqual(generatedContentHash(changed, statement, 'xlsx'), generatedContentHash(original, statement, 'xlsx'));
  changed.payment = original.payment;
  changed.totals.total_paid += 100;
  assert.notEqual(generatedContentHash(changed, statement, 'xlsx'), generatedContentHash(original, statement, 'xlsx'));
  assert.notEqual(generatedContentHash(original, statement, 'xlsx'), generatedContentHash(fixture(), statement, 'xlsx'));
});

test('canonical key ordering and equivalent date representations do not invalidate content', () => {
  const original = fixture();
  const changed = fixture();
  changed.plot = Object.fromEntries(Object.entries(changed.plot).reverse());
  changed.agents[0] = Object.fromEntries(Object.entries(changed.agents[0]).reverse());
  changed.allPayments[0].date = new Date(2026, 8, 2);
  changed.plot.booking_date = new Date(2026, 8, 1);
  changed.allPayments[0].id = '1';
  for (const format of ['xlsx', 'pdf']) assert.equal(generatedContentHash(changed, statement, format), generatedContentHash(original, statement, format));
});

test('logical file identity survives dates, names, requester changes and database ID representations', () => {
  const original = key();
  assert.equal(key({ share: { ...share, id: 999, shared_by: 77, label: 'New agent name', created_at: '2027-01-01', folder_path: '2027/renamed', organization_id: '3', site_id: '2', entity_id: '20' }, item: { ...statement, name: 'Renamed Statement', folder: 'Renamed Folder' } }), original);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength('dg_logical_file_key') + Buffer.byteLength(original) <= 124);
});

test('logical identities isolate organization, site, entity, format, kind, payment and visibility', () => {
  const original = key();
  for (const changed of [
    { share: { ...share, organization_id: 4 } },
    { share: { ...share, site_id: 4 } },
    { share: { ...share, entity_id: 21 } },
    { share: { ...share, entity_type: 'land' } },
    { share: { ...share, module: 'land_commission' } },
    { format: 'pdf' },
    { item: profile, format: 'pdf' },
    { share: { ...share, scope: 'transaction', payment_id: 1 } },
    { visibility: { canViewAll: false, creatorId: 8 } },
  ]) assert.notEqual(key(changed), original);
  const transaction = { ...share, scope: 'transaction', payment_id: 1 };
  assert.notEqual(key({ share: transaction }), key({ share: { ...transaction, payment_id: 2 } }));
  assert.notEqual(key({ share: transaction, visibility: { canViewAll: false, creatorId: 8 } }), key({ share: transaction, visibility: { canViewAll: false, creatorId: 9 } }));
  assert.equal(key({ visibility: { creatorId: '9,8,8', canViewAll: true } }), key({ visibility: { canViewAll: true, creatorId: [8, 9] } }));
});

test('explicit content visibility changes hash and unsupported/missing identities fail closed', () => {
  const original = { ...fixture(), entryVisibility: visibility };
  assert.notEqual(generatedContentHash(original, statement, 'xlsx'), generatedContentHash({ ...original, entryVisibility: { canViewAll: false, creatorId: 8 } }, statement, 'xlsx'));
  assert.throws(() => key({ visibility: undefined }), /visibility is required/);
  assert.throws(() => key({ share: { ...share, scope: 'transaction', payment_id: null } }), /identity are required/);
  assert.throws(() => generatedContentHash(fixture(), { kind: 'voucher' }, 'xlsx'), /supported generated/);
  assert.throws(() => key({ item: profile, format: 'xlsx' }), /supported generated/);
});

test('sync summaries report explicit actions, count errors first and do not invent legacy outcomes', () => {
  assert.deepEqual(shareSyncSummary([
    { action: 'created' }, { action: 'updated' }, { action: 'unchanged' }, { action: 'unchanged' },
    { error: 'Too large' }, { action: 'updated', error: 'Failed upload' }, { action: 'failed' },
    { drive_file_id: 'legacy-file-with-unknown-action' },
  ]), { created: 1, updated: 1, unchanged: 2, failed: 3 });
  assert.deepEqual(shareSyncSummary(), { created: 0, updated: 0, unchanged: 0, failed: 0 });
});

test('attachment identities use storage source, omit signed URL volatility and retain access isolation', () => {
  for (const kind of ['document', 'voucher', 'signature']) {
    const item = { kind, name: 'Original.png', source: 'https://bucket.test/records/file.png?signature=old#preview', payment_id: 1 };
    const original = key({ item, format: 'binary' });
    assert.equal(key({ item: { ...item, name: 'Renamed.png', source: 'https://bucket.test/records/file.png?signature=new#other', payment_id: '1' }, format: 'binary' }), original);
    assert.notEqual(key({ item: { ...item, source: 'https://bucket.test/records/different.png?signature=old' }, format: 'binary' }), original);
    assert.notEqual(key({ item: { ...item, payment_id: 2 }, format: 'binary' }), original);
    assert.notEqual(key({ item, format: 'binary', share: { ...share, site_id: 99 } }), original);
    assert.notEqual(key({ item, format: 'binary', visibility: { canViewAll: false, creatorId: 8 } }), original);
    assert.equal(original.includes('bucket'), false, 'only the digest leaves the helper');
    assert.throws(() => generatedContentHash(fixture(), item, 'binary'), /supported generated/);
  }
  const document = { kind: 'document', source: 'record_documents/proof.pdf' };
  assert.equal(key({ item: document, format: 'binary' }), key({ item: { ...document, name: 'Renamed.pdf' }, format: 'binary' }));
  assert.notEqual(key({ item: document, format: 'binary' }), key({ item: { ...document, source: 'record_documents/other.pdf' }, format: 'binary' }));
  assert.throws(() => key({ item: { kind: 'document' }, format: 'binary' }), /stable attachment source/);
});

test('every rendered accounting field correction in the fixture invalidates its generated-file hash', () => {
  const original = fixture();
  const paths = [
    ...Object.keys(original.site).map((field) => ['site', field]),
    ...Object.keys(original.plot).map((field) => ['plot', field]),
    ...Object.keys(original.agents[0]).map((field) => ['agents', 0, field]),
    ...original.allPayments.flatMap((payment, index) => Object.keys(payment).map((field) => ['allPayments', index, field])),
    ...Object.keys(original.totals).map((field) => ['totals', field]),
  ];
  const workbookValues = (bundle) => {
    const wb = XLSX.read(buildStatementXlsx(bundle), { type: 'buffer' });
    return JSON.stringify(wb.SheetNames.map((name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 })));
  };
  const renderers = [
    { item: statement, format: 'xlsx', render: workbookValues },
    { item: statement, format: 'doc', render: renderStatementHtml },
    { item: profile, format: 'doc', render: renderProfileHtml },
  ].map((renderer) => ({ ...renderer, rendered: renderer.render(original), hash: generatedContentHash(original, renderer.item, renderer.format) }));
  const changedCounts = [0, 0, 0];
  for (const path of paths) {
    const changed = fixture();
    const parent = path.slice(0, -1).reduce((value, part) => value[part], changed);
    const field = path.at(-1);
    parent[field] = field.endsWith('date') ? '2027-01-15'
      : typeof parent[field] === 'number' ? parent[field] + 1 : `${parent[field]} changed`;
    renderers.forEach(({ item, format, render, rendered, hash }, index) => {
      if (render(changed) === rendered) return;
      changedCounts[index] += 1;
      assert.notEqual(generatedContentHash(changed, item, format), hash, `${item.kind}/${format}: ${path.join('.')} changed displayed data without changing its hash`);
    });
  }
  assert.ok(changedCounts.every((count) => count >= 20), 'exercise real cell/text differences for each generated document');
});
