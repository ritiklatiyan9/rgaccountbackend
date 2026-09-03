import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOpsToSheet, groupOpsBySheet, sanitizeSheetSnapshot, validateSheetList,
  resolveAccessLevel, hasLevel, SpreadsheetOpError,
} from '../src/utils/spreadsheetOps.js';

const cell = (r, c, v) => ({ r, c, v });

test('cell ops map the dense data path onto sparse celldata', () => {
  const sheet = { id: 's1', name: 'Sheet1', celldata: [cell(0, 0, { v: 1, m: '1' })] };
  applyOpsToSheet(sheet, [
    { op: 'replace', id: 's1', path: ['data', 0, 0], value: { v: 2, m: '2' } },
    { op: 'add', id: 's1', path: ['data', 3, 2], value: { v: 'x', m: 'x' } },
    { op: 'replace', id: 's1', path: ['data', 3, 2, 'bg'], value: '#ff0' },
    { op: 'replace', id: 's1', path: ['data', 0, 0], value: null },
  ]);
  assert.deepEqual(sheet.celldata, [cell(3, 2, { v: 'x', m: 'x', bg: '#ff0' })]);
});

test('config and metadata ops apply generically; transient UI state is ignored', () => {
  const sheet = { id: 's1', name: 'Sheet1', celldata: [], config: { columnlen: { 0: 80 } } };
  applyOpsToSheet(sheet, [
    { op: 'replace', id: 's1', path: ['config', 'columnlen', '2'], value: 140 },
    { op: 'add', id: 's1', path: ['config', 'merge', '0_0'], value: { r: 0, c: 0, rs: 2, cs: 2 } },
    { op: 'replace', id: 's1', path: ['frozen'], value: { type: 'row' } },
    { op: 'replace', id: 's1', path: ['name'], value: 'Collections' },
    { op: 'replace', id: 's1', path: ['luckysheet_select_save'], value: [{ row: [1, 1] }] },
    { op: 'remove', id: 's1', path: ['config', 'columnlen', '0'] },
  ]);
  assert.deepEqual(sheet.config, { columnlen: { 2: 140 }, merge: { '0_0': { r: 0, c: 0, rs: 2, cs: 2 } } });
  assert.deepEqual(sheet.frozen, { type: 'row' });
  assert.equal(sheet.name, 'Collections');
  assert.equal(sheet.luckysheet_select_save, undefined);
});

test('structural ops and prototype pollution paths are rejected', () => {
  assert.throws(() => groupOpsBySheet([{ op: 'insertRowCol', id: 's1', path: [], value: {} }]), /snapshots/);
  assert.throws(() => groupOpsBySheet([{ op: 'replace', id: 's1', path: ['__proto__', 'polluted'], value: 1 }]), SpreadsheetOpError);
  assert.throws(() => groupOpsBySheet([{ op: 'replace', id: 's1', path: ['data', -1, 0], value: {} }]), SpreadsheetOpError);
  assert.throws(() => groupOpsBySheet([{ op: 'replace', path: ['data', 0, 0], value: {} }]), /missing its sheet/);
  assert.throws(() => groupOpsBySheet(new Array(5001).fill({ op: 'replace', id: 's1', path: ['x'], value: 1 })), /Too many/);
  assert.equal(Object.prototype.polluted, undefined);
});

test('snapshot sanitising converts a dense matrix, strips transient keys and validates names', () => {
  const sheet = sanitizeSheetSnapshot({
    id: 'abc', name: '  Sales  ', data: [[{ v: 1 }, null], [null, { v: 2, f: '=A1*2' }]],
    luckysheet_select_save: [{}], status: 1, config: { merge: {} }, hide: 0, __proto__: { evil: true },
  });
  assert.deepEqual(sheet, {
    config: { merge: {} }, hide: 0, id: 'abc', name: 'Sales',
    celldata: [cell(0, 0, { v: 1 }), cell(1, 1, { v: 2, f: '=A1*2' })],
  });
  assert.throws(() => validateSheetList([{ id: 'a', name: 'X', celldata: [] }, { id: 'b', name: 'x', celldata: [] }]), /Duplicate sheet name/);
  assert.throws(() => validateSheetList([]), /at least one sheet/);
  assert.throws(() => sanitizeSheetSnapshot({ id: 'a', name: 'A', celldata: [{ r: 0, c: 'x', v: {} }] }), /invalid cell/);
});

test('access level: admin > owner > share > site assignment + module RBAC; foreign site is invisible', () => {
  const workbook = { id: 1, owner_user_id: 7, site_id: 3 };
  assert.equal(resolveAccessLevel({ user: { id: 99, role: 'admin' }, workbook, siteOk: false }), 'owner');
  assert.equal(resolveAccessLevel({ user: { id: 7, role: 'sub_admin' }, workbook, siteOk: false }), 'owner');
  assert.equal(resolveAccessLevel({ user: { id: 8, role: 'sub_admin' }, workbook, shareLevel: 'viewer', siteOk: false, permission: { can_update: true } }), 'viewer');
  assert.equal(resolveAccessLevel({ user: { id: 8, role: 'sub_admin' }, workbook, siteOk: true, permission: { can_read: true, can_update: true } }), 'editor');
  assert.equal(resolveAccessLevel({ user: { id: 8, role: 'sub_admin' }, workbook, siteOk: true, permission: { can_read: true, can_update: false } }), 'viewer');
  assert.equal(resolveAccessLevel({ user: { id: 8, role: 'sub_admin' }, workbook, siteOk: false, permission: { can_read: true, can_update: true } }), null);
  assert.equal(resolveAccessLevel({ user: { id: 8, role: 'sub_admin' }, workbook, siteOk: true, permission: null }), null);
  assert.equal(hasLevel('viewer', 'editor'), false);
  assert.equal(hasLevel('editor', 'commenter'), true);
  assert.equal(hasLevel(null, 'viewer'), false);
});
