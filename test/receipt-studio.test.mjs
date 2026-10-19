import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReceiptDesign, getReceiptDesign, getReceiptDesignWithScope, saveReceiptDesign, RECEIPT_DESIGN_KEY, RECEIPT_SITE_DESIGN_KEY } from '../src/services/receiptDesign.service.js';
import settings from '../src/models/ApplicationSetting.model.js';
import pool from '../src/config/db.js';

const canvas = { layout_mode: 'canvas', elements: [{ id: 'letter', type: 'text', text: ' . \nA & B', x: 10, y: 20, width: 30, height: 6 }] };
test('TDS receipt rows and canvas tokens survive save and reload for shared and commission-specific designs', () => {
  const keys = ['gross_amount', 'tds_applicable', 'tds_section', 'tds_mode', 'tds_rate', 'tds_amount', 'net_amount'];
  const legacy = normalizeReceiptDesign({ modules: { commission_payment: { non_cash: { detail_items: [{ key: 'module', label: 'Account', enabled: true }] } } } });
  for (const mode of ['cash', 'cheque', 'non_cash', 'cheque_reconciliation']) {
    for (const key of keys) assert.equal(legacy[mode].detail_items.find(item => item.key === key).enabled, false);
  }
  for (const key of keys) assert.equal(legacy.modules.commission_payment.non_cash.detail_items.find(item => item.key === key).enabled, false);
  const customization = { detail_items: [{ key: 'tds_amount', label: 'Tax withheld', sample: '₹2,000', enabled: true }, { key: 'tds_rate', label: 'Rate', enabled: false }],
    layout_mode: 'canvas', elements: [{ id: 'tax', type: 'field', field: 'tds_amount', prefix: 'Tax: ', x: 10, y: 10, width: 80, height: 8 }, { id: 'net', type: 'text', text: 'Pay {{net_amount}}', x: 10, y: 20, width: 80, height: 8 }] };
  const saved = normalizeReceiptDesign({ cash: customization, modules: { commission_payment: { non_cash: customization } } });
  for (const mode of [saved.cash, saved.modules.commission_payment.non_cash]) {
    assert.equal(mode.detail_items.find(item => item.key === 'tds_amount').label, 'Tax withheld');
    assert.equal(mode.detail_items.find(item => item.key === 'tds_amount').enabled, true);
    assert.equal(mode.detail_items.find(item => item.key === 'tds_rate').enabled, false);
    assert.equal(mode.elements[0].field, 'tds_amount');
    assert.equal(mode.elements[1].text, 'Pay {{net_amount}}');
  }
  assert.deepEqual(normalizeReceiptDesign(saved), saved);
});
test('empty content, punctuation, free canvas and module inheritance survive saving', () => {
  const saved = normalizeReceiptDesign({ cash: { ...canvas, content: { title: '', separator: ' . ', footer: '\n.' } }, modules: { expense: { cash: { ...canvas, content: { title: 'Expense' } } } } });
  assert.equal(saved.cash.content.title, ''); assert.equal(saved.cash.content.separator, ' . '); assert.equal(saved.cash.content.footer, '\n.');
  assert.equal(saved.cash.elements[0].text, ' . \nA & B');
  assert.equal(saved.modules.expense.cash.content.title, 'Expense');
  assert.equal(saved.modules.expense.non_cash, undefined, 'unspecified modes inherit shared settings');
  assert.deepEqual(normalizeReceiptDesign(saved), saved);
});
test('layout validation bounds geometry and excludes executable element types and URLs', () => {
  const saved = normalizeReceiptDesign({ cash: { ...canvas, elements: [ { ...canvas.elements[0], x: -5, font_size: 999, color: 'red;position:fixed' }, { type: 'script', text: 'alert(1)' }, { type: 'image', src: 'javascript:alert(1)' }] } });
  assert.equal(saved.cash.elements.length, 2); assert.equal(saved.cash.elements[0].x, 0); assert.equal(saved.cash.elements[0].font_size, 96);
  assert.equal(saved.cash.elements[0].color, '#222222'); assert.equal(saved.cash.elements[1].src, '');
});
test('the same global design is returned from every site and saves use global storage', async () => {
  const get = settings.getGlobalJson, set = settings.setGlobalJson, own = settings.getJson, retire = settings.deleteJsonForAllSites;
  const expected = normalizeReceiptDesign({ cash: { content: { title: 'Global format' } } });
  let retired = '';
  settings.getGlobalJson = async key => { assert.equal(key, RECEIPT_DESIGN_KEY); return expected; };
  settings.setGlobalJson = async (key,value,by) => { assert.equal(key, RECEIPT_DESIGN_KEY); assert.equal(by, 7); return value; };
  settings.getJson = async () => null;
  settings.deleteJsonForAllSites = async key => { retired = key; };
  try {
    assert.deepEqual(await getReceiptDesign(1), await getReceiptDesign(5)); assert.deepEqual(await saveReceiptDesign(99, expected, 7), expected);
    assert.equal(retired, RECEIPT_SITE_DESIGN_KEY, 'saving for all sites retires site-only designs');
  }
  finally { settings.getGlobalJson = get; settings.setGlobalJson = set; settings.getJson = own; settings.deleteJsonForAllSites = retire; }
});
test('unconfigured sites inherit OM ASSOCIATES without mutating its legacy design', async () => {
  const get = settings.getGlobalJson, query = pool.query, own = settings.getJson;
  const legacy = { cash: { content: { title: 'OM receipt' } } };
  settings.getGlobalJson = async () => null;
  settings.getJson = async () => null;
  pool.query = async (sql,params) => { assert.match(sql, /OM ASSOCIATES/); assert.deepEqual(params,[RECEIPT_DESIGN_KEY]); return { rows: [{ setting_value: legacy }] }; };
  try { assert.equal((await getReceiptDesign(999)).cash.content.title, 'OM receipt'); assert.deepEqual(legacy, { cash: { content: { title: 'OM receipt' } } }); }
  finally { settings.getGlobalJson = get; pool.query = query; settings.getJson = own; }
});

test('a site design overrides the shared design only for that site and saves under its own key', async () => {
  const get = settings.getGlobalJson, own = settings.getJson, setOwn = settings.setJson, setGlobal = settings.setGlobalJson;
  settings.getGlobalJson = async () => ({ cash: { content: { title: 'Shared' } } });
  settings.getJson = async (siteId, key) => { assert.equal(key, RECEIPT_SITE_DESIGN_KEY); return siteId === 3 ? { cash: { content: { title: 'Site 3' } } } : null; };
  let stored;
  settings.setJson = async (siteId, key, value) => { stored = { siteId, key }; return value; };
  settings.setGlobalJson = async () => { throw new Error('a site save must not touch the shared design'); };
  try {
    assert.deepEqual([(await getReceiptDesignWithScope(3)).scope, (await getReceiptDesign(3)).cash.content.title], ['site', 'Site 3']);
    assert.deepEqual([(await getReceiptDesignWithScope(4)).scope, (await getReceiptDesign(4)).cash.content.title], ['global', 'Shared']);
    await saveReceiptDesign(3, {}, 7, 'site');
    assert.deepEqual(stored, { siteId: 3, key: RECEIPT_SITE_DESIGN_KEY });
  } finally { settings.getGlobalJson = get; settings.getJson = own; settings.setJson = setOwn; settings.setGlobalJson = setGlobal; }
});
