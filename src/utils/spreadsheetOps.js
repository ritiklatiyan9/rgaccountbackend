/**
 * Pure helpers shared by the spreadsheet controller and its tests.
 *
 * Stored sheet document = FortuneSheet `Sheet` JSON with a sparse `celldata`
 * array ({ r, c, v }) and WITHOUT the dense `data` matrix. Client edit ops are
 * immer patches produced by FortuneSheet (`op`, `path`, `value`, `id`), where
 * a path starting with "data" addresses the dense matrix; this module maps
 * those onto `celldata` so a keystroke never ships the whole sheet.
 */

const MAX_OPS_PER_BATCH = 5000;
const MAX_PATH_DEPTH = 12;
const MAX_CELLS_PER_SHEET = 2_000_000;
const MAX_SHEETS = 200;
const MAX_NAME = 255;

// Keys that describe UI/session state, or that the client must never send.
const TRANSIENT_SHEET_KEYS = new Set([
  'data', 'luckysheet_select_save', 'luckysheet_selection_range', 'status',
  'luckysheet_selection_range', 'dynamicArray_compute', 'filter_select',
]);
// Structural ops need a re-indexed sheet: the client sends a snapshot instead.
export const STRUCTURAL_OPS = new Set(['insertRowCol', 'deleteRowCol', 'addSheet', 'deleteSheet']);

export class SpreadsheetOpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const isIndex = (segment) => Number.isInteger(segment) && segment >= 0;
const isKey = (segment) => typeof segment === 'string' && segment.length > 0 && segment.length <= 80
  && segment !== '__proto__' && segment !== 'constructor' && segment !== 'prototype';

export const validateOp = (op) => {
  if (!op || typeof op !== 'object') throw new SpreadsheetOpError('Malformed change');
  if (!['replace', 'add', 'remove'].includes(op.op)) {
    if (STRUCTURAL_OPS.has(op.op)) throw new SpreadsheetOpError('Structural changes must be sent as sheet snapshots');
    throw new SpreadsheetOpError(`Unsupported change type: ${String(op.op).slice(0, 20)}`);
  }
  if (typeof op.id !== 'string' || !op.id || op.id.length > 64) throw new SpreadsheetOpError('Change is missing its sheet');
  if (!Array.isArray(op.path) || op.path.length === 0 || op.path.length > MAX_PATH_DEPTH) {
    throw new SpreadsheetOpError('Change path is invalid');
  }
  for (const segment of op.path) {
    if (!isIndex(segment) && !isKey(segment)) throw new SpreadsheetOpError('Change path is invalid');
  }
  if (op.path[0] === 'data' && (op.path.length < 3 || !isIndex(op.path[1]) || !isIndex(op.path[2]))) {
    throw new SpreadsheetOpError('Cell change path is invalid');
  }
  return op;
};

const setAtPath = (root, path, op, value) => {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (node[segment] == null || typeof node[segment] !== 'object') {
      node[segment] = isIndex(path[i + 1]) ? [] : {};
    }
    node = node[segment];
  }
  const last = path[path.length - 1];
  if (op === 'remove') {
    if (Array.isArray(node) && isIndex(last)) node.splice(last, 1);
    else delete node[last];
    return;
  }
  if (op === 'add' && Array.isArray(node) && isIndex(last)) {
    node.splice(last, 0, value);
    return;
  }
  node[last] = value;
};

/** Apply validated ops for ONE sheet to its stored document (mutates + returns it). */
export function applyOpsToSheet(sheet, ops) {
  if (!Array.isArray(sheet.celldata)) sheet.celldata = [];
  const index = new Map();
  sheet.celldata.forEach((cell, i) => index.set(`${cell.r}_${cell.c}`, i));

  for (const op of ops) {
    const { path } = op;
    if (path[0] !== 'data') {
      if (TRANSIENT_SHEET_KEYS.has(path[0])) continue;
      if (path.length === 1 && path[0] === 'name') {
        sheet.name = String(op.value ?? '').slice(0, MAX_NAME) || sheet.name;
        continue;
      }
      setAtPath(sheet, path, op.op, op.value);
      continue;
    }

    const r = path[1];
    const c = path[2];
    const key = `${r}_${c}`;
    const rest = path.slice(3);
    const existing = index.get(key);

    if (rest.length === 0) {
      const cellValue = op.op === 'remove' ? null : op.value;
      if (cellValue == null) {
        if (existing != null) {
          sheet.celldata.splice(existing, 1);
          index.delete(key);
          for (const [k, i] of index) if (i > existing) index.set(k, i - 1);
        }
        continue;
      }
      if (typeof cellValue !== 'object') throw new SpreadsheetOpError('Cell value must be an object');
      if (existing != null) sheet.celldata[existing].v = cellValue;
      else {
        index.set(key, sheet.celldata.length);
        sheet.celldata.push({ r, c, v: cellValue });
      }
      continue;
    }

    let entry = existing != null ? sheet.celldata[existing] : null;
    if (!entry) {
      entry = { r, c, v: {} };
      index.set(key, sheet.celldata.length);
      sheet.celldata.push(entry);
    }
    if (entry.v == null || typeof entry.v !== 'object') entry.v = {};
    setAtPath(entry.v, rest, op.op, op.value);
  }

  if (sheet.celldata.length > MAX_CELLS_PER_SHEET) throw new SpreadsheetOpError('Sheet exceeds the supported cell count', 413);
  return sheet;
}

/** Group a mixed batch of ops by sheet key, validating each one. */
export function groupOpsBySheet(ops) {
  if (!Array.isArray(ops)) throw new SpreadsheetOpError('Changes must be a list');
  if (ops.length > MAX_OPS_PER_BATCH) throw new SpreadsheetOpError('Too many changes in one request; split the batch', 413);
  const grouped = new Map();
  for (const op of ops) {
    validateOp(op);
    if (!grouped.has(op.id)) grouped.set(op.id, []);
    grouped.get(op.id).push(op);
  }
  return grouped;
}

const isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate and normalise a client-sent sheet snapshot before it is stored.
 * Strips transient state and the dense matrix; keeps everything FortuneSheet
 * needs to rebuild the sheet (config, merges, widths, filters, validation,
 * conditional formats, frozen panes, hyperlinks, images, calcChain).
 */
export function sanitizeSheetSnapshot(raw) {
  if (!isPlainObject(raw)) throw new SpreadsheetOpError('Sheet snapshot is malformed');
  const id = typeof raw.id === 'string' ? raw.id.slice(0, 64) : null;
  if (!id) throw new SpreadsheetOpError('Sheet snapshot is missing its id');
  const name = String(raw.name ?? 'Sheet').trim().slice(0, MAX_NAME) || 'Sheet';

  let celldata = raw.celldata;
  if (celldata == null && Array.isArray(raw.data)) {
    celldata = [];
    raw.data.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, c) => { if (cell != null) celldata.push({ r, c, v: cell }); });
    });
  }
  if (!Array.isArray(celldata)) celldata = [];
  if (celldata.length > MAX_CELLS_PER_SHEET) throw new SpreadsheetOpError('Sheet exceeds the supported cell count', 413);
  const cleanCells = [];
  for (const cell of celldata) {
    if (!isPlainObject(cell) || !isIndex(cell.r) || !isIndex(cell.c)) throw new SpreadsheetOpError('Sheet snapshot has an invalid cell');
    if (cell.v == null) continue;
    if (typeof cell.v !== 'object') throw new SpreadsheetOpError('Sheet snapshot has an invalid cell value');
    cleanCells.push({ r: cell.r, c: cell.c, v: cell.v });
  }

  const sheet = {};
  for (const [key, value] of Object.entries(raw)) {
    if (TRANSIENT_SHEET_KEYS.has(key) || key === 'celldata' || key === 'id' || key === 'name') continue;
    if (!isKey(key)) continue;
    if (value === undefined) continue;
    sheet[key] = value;
  }
  sheet.id = id;
  sheet.name = name;
  sheet.celldata = cleanCells;
  if (sheet.config != null && !isPlainObject(sheet.config)) delete sheet.config;
  if (sheet.order != null && !Number.isInteger(sheet.order)) delete sheet.order;
  sheet.hide = sheet.hide === 1 ? 1 : 0;
  return sheet;
}

export function validateSheetList(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new SpreadsheetOpError('A workbook needs at least one sheet');
  if (sheets.length > MAX_SHEETS) throw new SpreadsheetOpError(`A workbook may hold at most ${MAX_SHEETS} sheets`, 413);
  const clean = sheets.map(sanitizeSheetSnapshot);
  const ids = new Set();
  const names = new Set();
  for (const sheet of clean) {
    if (ids.has(sheet.id)) throw new SpreadsheetOpError('Duplicate sheet id in workbook');
    const lowered = sheet.name.toLowerCase();
    if (names.has(lowered)) throw new SpreadsheetOpError(`Duplicate sheet name: ${sheet.name}`);
    ids.add(sheet.id);
    names.add(lowered);
  }
  return clean.map((sheet, i) => ({ ...sheet, order: Number.isInteger(sheet.order) ? sheet.order : i }));
}

export const ACCESS_RANK = Object.freeze({ viewer: 1, commenter: 2, editor: 3, owner: 4 });

/**
 * Resolve a caller's effective access level for a workbook. Returns null when
 * the workbook must be invisible to the caller (rendered as 404 upstream).
 *
 * Order: org admin → owner → explicit share → site assignment + RBAC.
 * A share is an explicit grant, so it applies even without a site assignment;
 * everything else requires the workbook's site (or org-wide scope).
 */
export function resolveAccessLevel({ user, workbook, shareLevel, siteOk, permission }) {
  if (!user || !workbook) return null;
  if (user.role === 'admin' || user.role === 'super_admin') return 'owner';
  if (workbook.owner_user_id != null && Number(workbook.owner_user_id) === Number(user.id)) return 'owner';
  if (shareLevel && ACCESS_RANK[shareLevel]) return shareLevel;
  if (!siteOk) return null;
  if (permission?.can_update === true) return 'editor';
  if (permission?.can_read === true) return 'viewer';
  return null;
}

export const hasLevel = (level, required) => Boolean(level) && ACCESS_RANK[level] >= ACCESS_RANK[required];
