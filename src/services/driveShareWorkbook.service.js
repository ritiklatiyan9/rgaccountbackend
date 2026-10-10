import * as XLSX from '@e965/xlsx';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const MONEY = '"₹" #,##0.00;[Red]("₹" #,##0.00);"–"';
const DATE = 'dd mmm yyyy';
const DATETIME = 'dd mmm yyyy hh:mm';
const numberTypes = new Set(['money', 'currency', 'amount', 'number', 'integer', 'percent']);
const moneyTypes = new Set(['money', 'currency', 'amount']);
const isDateType = (type) => type === 'date' || type === 'datetime';
const formatDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }).format(date);
};
const formatDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date)} IST`;
};
const datetimeSerial = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? '') : (date.getTime() + 330 * 60000 - Date.UTC(1899, 11, 30)) / 86400000;
};
const dateSerial = (value) => {
  if (value == null || value === '') return null;
  const text = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}` : String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return String(value);
  const serial = (Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30)) / 86400000;
  return Number.isFinite(serial) ? serial : String(value);
};

export const durableDocumentUrl = (document) => {
  if (!document?.linkVersion || !document.url) return null;
  try {
    const url = new URL(document.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !/\/public\/drive-documents\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
    return url.toString();
  } catch { return null; }
};

/** Content projection omits generation times, bearer tokens and expiring S3
 * signatures. Storage identity and access revision still invalidate a share. */
export const moduleShareProjection = (bundle) => ({
  rendererVersion: 1, moduleKey: bundle.moduleKey, moduleLabel: bundle.moduleLabel,
  siteId: bundle.siteId, entityId: bundle.entityId, entityType: bundle.entityType,
  scope: bundle.scope, viewFilters: bundle.viewFilters || null, entryVisibility: bundle.entryVisibility, label: bundle.label, sheets: bundle.sheets || [], summary: bundle.summary || {},
  documents: (bundle.documents || []).map((document) => ({
    id: document.id, name: document.name, sourceModule: document.sourceModule, sourceId: document.sourceId,
    sourceFingerprint: document.sourceFingerprint || null, linkVersion: document.linkVersion || null,
    unavailable: document.unavailable || (!durableDocumentUrl(document) ? 'Link unavailable' : null),
  })),
});

/** SheetJS CE writes numbers/links/ZIP reliably but ignores font/fill styles.
 * Append OOXML styles and frozen panes to its own generated archive, preserving
 * existing number formats. This keeps the deployed dependency set unchanged. */
export const writeDriveWorkbook = (workbook, { sheetOptions = {} } = {}) => {
  const zip = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }), { type: 'buffer' });
  const entry = (path) => XLSX.CFB.find(zip, `Root Entry/${path}`);
  const read = (path) => Buffer.from(entry(path).content).toString('utf8');
  const write = (path, xml) => { const file = entry(path); file.content = Buffer.from(xml); file.size = file.content.length; };
  let styles = read('xl/styles.xml');
  const fontCount = Number(/<fonts count="(\d+)"/.exec(styles)[1]);
  const fillCount = Number(/<fills count="(\d+)"/.exec(styles)[1]);
  const fonts = [
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
    '<font><b/><sz val="18"/><color rgb="FF17324D"/><name val="Calibri"/></font>',
    '<font><sz val="10"/><color rgb="FF64748B"/><name val="Calibri"/></font>',
    '<font><u/><sz val="11"/><color rgb="FF1763AD"/><name val="Calibri"/></font>',
  ].join('');
  styles = styles.replace(/<fonts count="\d+">([\s\S]*?)<\/fonts>/, `<fonts count="${fontCount + 4}">$1${fonts}</fonts>`)
    .replace(/<fills count="\d+">([\s\S]*?)<\/fills>/, `<fills count="${fillCount + 2}">$1<fill><patternFill patternType="solid"><fgColor rgb="FF17324D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill></fills>`);
  const originalXfs = /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/.exec(styles)[1];
  const xfs = originalXfs.match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
  const custom = new Map();
  const styleFor = (original, tone, striped) => {
    const key = `${original}:${tone}:${striped}`;
    if (custom.has(key)) return custom.get(key);
    const numFmt = /numFmtId="(\d+)"/.exec(xfs[original] || '')?.[1] || '0';
    const font = tone === 'header' ? fontCount : tone === 'title' ? fontCount + 1 : tone === 'subtitle' ? fontCount + 2 : tone === 'link' ? fontCount + 3 : 0;
    const fill = tone === 'header' ? fillCount : striped ? fillCount + 1 : 0;
    const index = xfs.length;
    xfs.push(`<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`);
    custom.set(key, index);
    return index;
  };
  workbook.SheetNames.forEach((name, index) => {
    const sheet = workbook.Sheets[name];
    const options = sheetOptions[name] || {};
    const headerRow = options.headerRow ?? 0;
    let xml = read(`xl/worksheets/sheet${index + 1}.xml`);
    xml = xml.replace(/<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>/g, (_tag, attrs, col, rowNumber) => {
      const row = Number(rowNumber) - 1;
      const original = Number(/\bs="(\d+)"/.exec(attrs)?.[1] || 0);
      const tone = row === headerRow ? 'header' : options.titleRows?.includes(row) ? 'title'
        : options.subtitleRows?.includes(row) ? 'subtitle' : sheet[`${col}${rowNumber}`]?.l ? 'link' : 'body';
      const selfClosing = /\/\s*$/.test(attrs);
      return `<c${attrs.replace(/\s+s="\d+"/, '').replace(/\/\s*$/, '')} s="${styleFor(original, tone, row > headerRow && row % 2 === 0)}"${selfClosing ? '/>' : '>'}`;
    });
    const freezeRows = options.freezeRows ?? headerRow + 1;
    if (freezeRows > 0) xml = xml.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${freezeRows}" topLeftCell="A${freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freezeRows + 1}" sqref="A${freezeRows + 1}"/></sheetView></sheetViews>`);
    write(`xl/worksheets/sheet${index + 1}.xml`, xml);
  });
  styles = styles.replace(/<cellXfs count="\d+">[\s\S]*?<\/cellXfs>/, `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`);
  write('xl/styles.xml', styles);
  return XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip', compression: true });
};

export const appendDriveDocumentsSheet = (workbook, documents = []) => {
  const rows = [['Document', 'Source', 'Record', 'Open document', 'Availability'],
    ...documents.map((document) => [document.name || 'Document', document.sourceModule || '', String(document.sourceId ?? ''), durableDocumentUrl(document) ? 'Open original document' : '', document.unavailable || (durableDocumentUrl(document) ? 'Available' : 'Link unavailable')])];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  documents.forEach((document, index) => {
    const url = durableDocumentUrl(document);
    if (url) sheet[`D${index + 2}`].l = { Target: url, Tooltip: 'Open the original stored document' };
  });
  sheet['!cols'] = [{ wch: 44 }, { wch: 24 }, { wch: 18 }, { wch: 28 }, { wch: 52 }];
  sheet['!rows'] = [{ hpt: 30 }];
  sheet['!autofilter'] = { ref: `A1:E${Math.max(1, rows.length)}` };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Documents');
};

const sheetName = (name, used) => {
  const clean = String(name || 'Records').replace(/[\\/?*\[\]:]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^'+|'+$/g, '').slice(0, 31) || 'Records';
  let result = clean;
  for (let i = 2; used.has(result.toLowerCase()); i += 1) { const suffix = ` ${i}`; result = `${clean.slice(0, 31 - suffix.length)}${suffix}`; }
  used.add(result.toLowerCase());
  return result;
};

export const buildModuleShareXlsx = (bundle) => {
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: `${bundle.moduleLabel || 'Accounting'} — ${bundle.label || 'Records'}`, Author: 'Defence Garden Accounts', Company: 'Defence Garden Accounts' };
  const summary = XLSX.utils.aoa_to_sheet([
    ['Defence Garden Accounts'], [bundle.moduleLabel || 'Accounting records'], [bundle.label || ''], [],
    ['Report detail', 'Value'], ['Scope', bundle.entryVisibility?.canViewAll === false ? `Entries created by User ${bundle.entryVisibility.creatorId}` : 'All authorized entries'], ['Generated', formatDate(bundle.generatedAt || new Date())],
    ['Records', Number(bundle.summary?.record_count ?? (bundle.sheets || []).reduce((sum, sheet) => sum + sheet.rows.length, 0))],
    ['Linked documents', (bundle.documents || []).length],
    ...(bundle.viewFilters ? [['Report view', 'Same filters as the module; all matching rows across all pages'],
      ...Object.entries(bundle.viewFilters).filter(([, value]) => value !== '' && value !== 'all').map(([key, value]) => [key.replace(/_/g, ' '), value])] : []),
    ['Document access', 'Use the Documents tab to open originals. CA access is managed in Google Drive settings.'],
  ]);
  summary['!cols'] = [{ wch: 30 }, { wch: 86 }];
  summary['!merges'] = [0, 1, 2].map((r) => ({ s: { r, c: 0 }, e: { r, c: 1 } }));
  summary['!rows'] = [{ hpt: 28 }, { hpt: 24 }, { hpt: 28 }, {}, { hpt: 26 }];
  XLSX.utils.book_append_sheet(workbook, summary, 'Summary');
  const used = new Set(['summary', 'documents']);
  const sheetOptions = { Summary: { headerRow: 4, titleRows: [0, 1], subtitleRows: [2], freezeRows: 5 }, Documents: { headerRow: 0 } };
  for (const data of bundle.sheets || []) {
    const columns = data.columns || [];
    if (!columns.length) continue;
    const name = sheetName(data.name, used);
    const values = (data.rows || []).map((record) => columns.map(({ key, type }) => {
      const value = record[key];
      if (value == null || value === '') return null;
      if (numberTypes.has(type)) return Number.isFinite(Number(value)) ? Number(value) : String(value);
      if (isDateType(type)) return type === 'datetime' ? datetimeSerial(value) : dateSerial(value);
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }));
    const sheet = XLSX.utils.aoa_to_sheet([[data.name || name], [bundle.label || ''], [], columns.map((column) => column.label || column.key), ...values]);
    sheet['!cols'] = columns.map((column, col) => ({ wch: Math.min(48, Math.max(numberTypes.has(column.type) ? 18 : isDateType(column.type) ? 17 : 16, String(column.label || column.key).length + 3,
      ...values.slice(0, 100).map((row) => String(row[col] ?? '').length + 2))) }));
    sheet['!merges'] = [0, 1].map((r) => ({ s: { r, c: 0 }, e: { r, c: Math.max(0, columns.length - 1) } }));
    sheet['!rows'] = [{ hpt: 27 }, { hpt: 28 }, {}, { hpt: 30 }];
    sheet['!autofilter'] = { ref: `A4:${XLSX.utils.encode_col(columns.length - 1)}${values.length + 4}` };
    columns.forEach(({ type }, col) => {
      const format = moneyTypes.has(type) ? MONEY : type === 'datetime' ? DATETIME : isDateType(type) ? DATE : type === 'percent' ? '0.00%' : type === 'integer' ? '#,##0' : type === 'number' ? '#,##0.00' : null;
      if (format) values.forEach((_, row) => { const cell = sheet[XLSX.utils.encode_cell({ r: row + 4, c: col })]; if (cell?.t === 'n') cell.z = format; });
    });
    XLSX.utils.book_append_sheet(workbook, sheet, name);
    sheetOptions[name] = { headerRow: 3, titleRows: [0], subtitleRows: [1], freezeRows: 4 };
  }
  appendDriveDocumentsSheet(workbook, bundle.documents || []);
  return writeDriveWorkbook(workbook, { sheetOptions });
};

export const renderModuleShareHtml = (bundle, { preview = true } = {}) => {
  const limit = preview ? 100 : Infinity;
  const table = (headers, rows) => `<div style="overflow-x:auto;max-width:100%;margin:12px 0 24px" tabindex="0" aria-label="Scroll to view all columns"><table style="width:100%;border-collapse:collapse"><thead><tr>${headers.map((value) => `<th style="min-width:110px;padding:9px;text-align:left;background:#17324d;color:white">${esc(value)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, index) => `<tr style="background:${index % 2 ? '#f1f5f9' : 'white'}">${row.map((value) => `<td style="padding:8px;border-bottom:1px solid #dce3eb;vertical-align:top">${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const sections = (bundle.sheets || []).map((sheet) => `<h2 style="font-size:16px;color:#17324d">${esc(sheet.name)}</h2><p style="color:#64748b">${sheet.rows.length} rows · ${sheet.columns.length} columns${sheet.columns.length > 8 ? ' · Scroll horizontally to view every column' : ''}</p>${sheet.rows.length > limit ? `<p style="color:#64748b">Showing 100 of ${sheet.rows.length} rows. Excel includes all ${sheet.rows.length}.</p>` : ''}${table(sheet.columns.map((column) => column.label || column.key), sheet.rows.slice(0, limit).map((row) => sheet.columns.map(({ key, type }) => {
    const value = row[key];
    return esc(value == null ? '' : moneyTypes.has(type) ? Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : type === 'datetime' ? formatDateTime(value) : isDateType(type) ? formatDate(value) : value);
  })))}`).join('');
  const documents = bundle.documents || [];
  const docs = (documents.length > limit ? `<p>Showing 100 of ${documents.length} documents. Excel includes all ${documents.length}.</p>` : '') + table(['Document', 'Source', 'Open document'], documents.slice(0, limit).map((document) => {
    const url = durableDocumentUrl(document);
    return [esc(document.name), esc(document.sourceModule), url ? `<a href="${esc(url)}" style="color:#1763ad">Open original document</a>` : esc(document.unavailable || 'Link unavailable')];
  }));
  const view = bundle.viewFilters ? `<p style="color:#64748b">Module filters · All matching records across all pages</p><p>${Object.entries(bundle.viewFilters)
    .filter(([, value]) => value !== '' && value !== 'all').map(([key, value]) => `${esc(key.replace(/_/g, ' '))}: ${esc(value)}`).join(' · ')}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(bundle.moduleLabel)} — ${esc(bundle.label)}</title></head><body style="font-family:Arial,sans-serif;color:#243449;font-size:12px;margin:28px"><div style="padding:22px;background:#17324d;color:white"><p style="margin:0 0 8px">DEFENCE GARDEN ACCOUNTS</p><h1 style="margin:0;font-size:24px">${esc(bundle.moduleLabel)}</h1><p>${esc(bundle.label)}</p></div><p style="color:#64748b">Generated ${esc(formatDate(bundle.generatedAt || new Date()))} · ${esc(bundle.viewFilters ? 'Current module view' : bundle.scope || 'overall')}</p>${view}${sections}<h2 style="font-size:16px;color:#17324d">Documents</h2>${docs}</body></html>`;
};
