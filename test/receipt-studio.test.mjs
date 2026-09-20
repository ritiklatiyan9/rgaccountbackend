import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReceiptDesign, getReceiptDesign, saveReceiptDesign, RECEIPT_DESIGN_KEY } from '../src/services/receiptDesign.service.js';
import settings from '../src/models/ApplicationSetting.model.js';
import pool from '../src/config/db.js';

const canvas = { layout_mode: 'canvas', elements: [{ id: 'letter', type: 'text', text: ' . \nA & B', x: 10, y: 20, width: 30, height: 6 }] };
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
  const get = settings.getGlobalJson, set = settings.setGlobalJson;
  const expected = normalizeReceiptDesign({ cash: { content: { title: 'Global format' } } });
  settings.getGlobalJson = async key => { assert.equal(key, RECEIPT_DESIGN_KEY); return expected; };
  settings.setGlobalJson = async (key,value,by) => { assert.equal(key, RECEIPT_DESIGN_KEY); assert.equal(by, 7); return value; };
  try { assert.deepEqual(await getReceiptDesign(1), await getReceiptDesign(5)); assert.deepEqual(await saveReceiptDesign(99, expected, 7), expected); }
  finally { settings.getGlobalJson = get; settings.setGlobalJson = set; }
});
test('unconfigured sites inherit OM ASSOCIATES without mutating its legacy design', async () => {
  const get = settings.getGlobalJson, query = pool.query;
  const legacy = { cash: { content: { title: 'OM receipt' } } };
  settings.getGlobalJson = async () => null;
  pool.query = async (sql,params) => { assert.match(sql, /OM ASSOCIATES/); assert.deepEqual(params,[RECEIPT_DESIGN_KEY]); return { rows: [{ setting_value: legacy }] }; };
  try { assert.equal((await getReceiptDesign(999)).cash.content.title, 'OM receipt'); assert.deepEqual(legacy, { cash: { content: { title: 'OM receipt' } } }); }
  finally { settings.getGlobalJson = get; pool.query = query; }
});
