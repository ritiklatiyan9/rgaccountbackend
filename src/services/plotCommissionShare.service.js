import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as XLSX from '@e965/xlsx';
import pool from '../config/db.js';
import { plotDetail } from '../controllers/plotCommissionV2.controller.js';
import { getPlotDocBytes } from '../utils/plotDocStorage.js';
import { memberDocumentStorage } from '../utils/memberDocumentUrls.js';
import { transactionMovesMoney } from '../utils/transactionPosting.js';
import { safeFilePart } from './yearEndDocuments.service.js';
import { istDateFolder, siteFolderName } from './googleDrive.service.js';

/**
 * Share domain for Project Commission → Google Drive: builds the data bundle for one
 * plot, renders it (statement / profile HTML, XLSX), plans the files to upload and
 * reads stored documents back from S3. Drive calls live in googleDrive.service.js.
 */

export const MODULE_FOLDER = 'Project Commission';
export const MODULE_KEY = 'plot_commission';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

const PROFILE_FOLDER = 'User Details';
const STATEMENT_FOLDER = 'Transaction Details';
const DOCUMENTS_FOLDER = 'Documents';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toNum = (v) => Number(v) || 0;
export const moneyINR = (v) => toNum(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// pg hands DATE columns over as a Date at local midnight, so read the local
// components back; strings arrive as YYYY-MM-DD (or an ISO prefix of it).
const isoDate = (d) => {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d));
  return m ? m[1] : String(d);
};
export const fmtDate = (d) => {
  const iso = isoDate(d);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
};
const fmtDateTimeIST = (d) => `${new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d)} IST`;

const paymentPosts = (p) => transactionMovesMoney({
  direction: toNum(p.amount) < 0 ? 'credit' : 'debit',
  status: p.status,
  paymentMode: p.payment_mode,
  chequeStatus: p.cheque_status,
});
export const maskAadhaar = (v) => {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 4 ? `XXXX XXXX ${digits.slice(-4)}` : '';
};
const extOf = (value, fallback) => {
  const m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(String(value || ''));
  return m ? m[1].toLowerCase() : fallback;
};
const EXT_BY_MIME = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const receiptNo = (id) => `CMN-${id}`;
const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Folders below the site's own Drive folder: <DD-MM-YYYY> / Project Commission /
 * Agent X - Plot A1. The site folder itself is resolved by id (googleDrive
 * ensureSiteFolder) because the site's CA is granted on exactly that folder.
 */
export const shareFolderSegments = ({ label, date = new Date() }) => [istDateFolder(date), MODULE_FOLDER, label];

/** Every payment of every booking of this plot, once each, oldest first, with its agent. */
const collectPayments = (detail) => {
  const byId = new Map();
  const add = (payments, agentName) => {
    for (const p of payments || []) if (!byId.has(p.id)) byId.set(p.id, { ...p, agent_name: agentName });
  };
  for (const a of detail.agents) add(a.payments, a.agent_name);
  for (const t of detail.timeline) for (const a of t.agents_detail || []) add(a.payments, a.agent_name);
  return [...byId.values()].sort((a, b) => isoDate(a.date).localeCompare(isoDate(b.date)) || a.id - b.id);
};

/** Totals count only rows that have actually posted (approved debit, cleared cheque, credit). */
const computeTotals = (payments, decided) => {
  let paid = 0;
  let tds = 0;
  for (const p of payments) {
    if (!paymentPosts(p)) continue;
    paid += toNum(p.amount) + toNum(p.tds_amount);
    tds += toNum(p.tds_amount);
  }
  return { total_commission: decided, total_paid: paid, tds_total: tds, balance: decided - paid, payment_count: payments.length };
};

export const buildPlotCommissionShareBundle = async ({ plotId, siteId, user, entryVisibility, scope = 'overall', paymentId, includeDocuments = true }) => {
  const detail = await plotDetail(plotId, siteId, entryVisibility);
  if (!detail) throw Object.assign(new Error('Plot not found'), { statusCode: 404 });

  const allPayments = collectPayments(detail);
  let payment = null;
  if (scope === 'transaction') {
    payment = allPayments.find((p) => Number(p.id) === Number(paymentId)) || null;
    if (!payment) throw Object.assign(new Error('Payment not found for this plot'), { statusCode: 404 });
  }
  const scopedPayments = payment ? [payment] : allPayments;
  const agentIds = detail.agents.map((a) => Number(a.agent_id)).filter((id) => Number.isInteger(id) && id > 0);
  // Excel already carries the statement and agent details. Avoid attachment
  // metadata reads entirely unless the requested share/preview needs them.
  const loadDocuments = includeDocuments || scope === 'documents';

  const [plotRes, siteRes, memberRes, docRes, receiptRes, userRes] = await Promise.all([
    pool.query(
      `SELECT plot_no, block, plot_size, plot_size_mtr, plot_rate, sale_price, buyer_name, booking_date, status,
              plot_commission, commission_rate, team
         FROM plots WHERE id = $1 AND site_id = $2`,
      [plotId, siteId],
    ),
    pool.query('SELECT name, city, state, address FROM sites WHERE id = $1', [siteId]),
    pool.query(
      `SELECT id, full_name, phone, alt_phone, email, address, city, state, pincode, pan_no, aadhar_no,
              bank_name, account_no, ifsc_code, branch, team, license_number, commission_rate
         FROM members WHERE id = ANY($1::int[])`,
      [agentIds],
    ),
    !loadDocuments || scope === 'transaction'
      ? { rows: [] }
      : pool.query(
        `SELECT id, title, original_name, file_path, mime_type, file_size, category, payment_mode, created_at
           FROM documents
          WHERE entity_type = 'plot-commission' AND entity_id = $1 AND uploaded_source = 'ACCOUNT_RECORD'
          ORDER BY created_at`,
        [plotId],
      ),
    loadDocuments ? pool.query(
      `SELECT record_id, customer_signature_url, authority_signature_url, evidence_photo_url
         FROM transaction_receipts
        WHERE module = 'commission_payment' AND record_id = ANY($1::text[])`,
      [scopedPayments.map((p) => String(p.id))],
    ) : { rows: [] },
    pool.query('SELECT name FROM users WHERE id = $1', [Number(user?.id) || 0]),
  ]);

  const plot = { ...detail.plot, ...(plotRes.rows[0] || {}) };
  const site = siteRes.rows[0] || { name: detail.plot.site_name };
  const members = new Map(memberRes.rows.map((m) => [m.id, m]));
  const agents = detail.agents.map((a) => {
    const m = members.get(Number(a.agent_id)) || {};
    return {
      commission_id: a.commission_id,
      agent_id: a.agent_id,
      agent_name: a.agent_name || m.full_name || '',
      phone: m.phone || a.agent_phone || '',
      alt_phone: m.alt_phone || '',
      email: m.email || '',
      address: [m.address, m.city, m.state, m.pincode].filter(Boolean).join(', '),
      pan_no: m.pan_no || '',
      aadhaar_masked: maskAadhaar(m.aadhar_no),
      bank_name: m.bank_name || '',
      account_no: m.account_no || '',
      ifsc_code: m.ifsc_code || '',
      branch: m.branch || '',
      team: m.team || '',
      license_number: m.license_number || '',
      commission_rate: m.commission_rate || '',
      total_commission: toNum(a.total_commission),
      total_paid: toNum(a.total_paid_all),
      balance: toNum(a.balance),
      status: a.status || '',
      remarks: a.remarks || '',
    };
  });

  const vouchers = (loadDocuments ? scopedPayments : [])
    .filter((p) => p.voucher_url)
    .map((p) => ({ payment_id: p.id, url: p.voucher_url, name: `Voucher ${receiptNo(p.id)}.${extOf(p.voucher_url, 'png')}` }));

  const seenUrls = new Set();
  const signatures = [];
  const addSignature = (paymentId, url, name) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    signatures.push({ payment_id: paymentId, url, name });
  };
  for (const p of loadDocuments ? scopedPayments : []) {
    addSignature(p.id, p.customer_signature_url, `Signature - ${receiptNo(p.id)} - Customer.png`);
    addSignature(p.id, p.authority_signature_url, `Signature - ${receiptNo(p.id)} - Authority.png`);
  }
  for (const r of receiptRes.rows) {
    const id = Number(r.record_id);
    addSignature(id, r.customer_signature_url, `Signature - ${receiptNo(id)} - Customer.png`);
    addSignature(id, r.authority_signature_url, `Signature - ${receiptNo(id)} - Authority.png`);
    addSignature(id, r.evidence_photo_url, `Evidence - ${receiptNo(id)}.${extOf(r.evidence_photo_url, 'jpg')}`);
  }

  const agentNames = agents.map((a) => a.agent_name).filter(Boolean);
  const label = safeFilePart(agentNames.length ? `Agent ${agentNames.join(', ')} - Plot ${plot.plot_no}` : `Plot ${plot.plot_no}`);

  return {
    scope,
    plot,
    site,
    agents,
    allPayments,
    payment,
    documents: docRes.rows,
    vouchers,
    signatures,
    label,
    siteFolderName: siteFolderName({ id: siteId, name: site.name }),
    folderSegments: shareFolderSegments({ label }),
    // The decided commission is plot-wide (never summed across agents/bookings), matching the app header.
    totals: computeTotals(allPayments, toNum(detail.grand?.total_commission)),
    generatedAt: new Date(),
    generatedBy: userRes.rows[0]?.name || user?.email || 'User',
  };
};

/* ───────────────────────── HTML (Google Docs import-safe: inline styles only) ───────────────────────── */

const FONT = 'font-family:Arial,Helvetica,sans-serif';
const INK = '#1f2937';
const NAVY = '#0f172a';
const MUTED = '#64748b';
const LINE = '#d6dbe3';
const ZEBRA = '#f6f7f9';
const HEAD_BG = '#eef2f7';

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>`
  + `<body style="margin:0;padding:0;background-color:#ffffff;${FONT};font-size:9.5pt;color:${INK}">${body}</body></html>`;

const headerBand = ({ eyebrow, title, subtitle, rightLabel, rightValue }) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:${NAVY}">`
  + `<tr><td style="padding:18px 22px;background-color:${NAVY};vertical-align:top">`
  + `<p style="margin:0;font-size:8pt;letter-spacing:1px;color:#94a3b8">${esc(String(eyebrow).toUpperCase())}</p>`
  + `<p style="margin:6px 0 0;font-size:17pt;font-weight:bold;color:#ffffff">${esc(title)}</p>`
  + `<p style="margin:6px 0 0;font-size:10pt;color:#e2e8f0">${esc(subtitle)}</p></td>`
  + `<td width="180" align="right" style="padding:18px 22px;background-color:${NAVY};vertical-align:top;text-align:right">`
  + `<p style="margin:0;font-size:8pt;letter-spacing:1px;color:#94a3b8">${esc(String(rightLabel).toUpperCase())}</p>`
  + `<p style="margin:6px 0 0;font-size:11pt;font-weight:bold;color:#ffffff">${esc(rightValue)}</p></td></tr></table>`;

const metaLine = (left, right) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:1px solid ${LINE}">`
  + `<tr><td style="padding:8px 2px;font-size:8.5pt;color:${MUTED}">${esc(left)}</td>`
  + `<td align="right" style="padding:8px 2px;font-size:8.5pt;color:${MUTED};text-align:right">${esc(right)}</td></tr></table>`;

const sectionTitle = (text) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px">`
  + `<tr><td style="padding:0 0 5px;border-bottom:1.5px solid ${NAVY};font-size:10.5pt;font-weight:bold;color:${NAVY}">${esc(text)}</td></tr></table>`;

const tiles = (items) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:14px">` + '<tr>'
  + items.map(({ label, value, tone }) => `<td width="${Math.floor(100 / items.length)}%" style="padding:10px 12px;border:1px solid ${LINE};background-color:#f8fafc;vertical-align:top">`
    + `<p style="margin:0;font-size:7.5pt;letter-spacing:0.5px;color:${MUTED}">${esc(String(label).toUpperCase())}</p>`
    + `<p style="margin:5px 0 0;font-size:12.5pt;font-weight:bold;color:${tone || NAVY}">${esc(value)}</p></td>`).join('')
  + '</tr></table>';

/** Key/value pairs laid out two per row. */
const kvTable = (pairs) => {
  const rows = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const cell = (pair) => (pair
      ? `<td width="18%" style="padding:6px 8px;border-bottom:1px solid ${LINE};font-size:8.5pt;color:${MUTED}">${esc(pair[0])}</td>`
        + `<td width="32%" style="padding:6px 8px;border-bottom:1px solid ${LINE};font-size:9.5pt;color:${INK}">${esc(pair[1] || '—')}</td>`
      : `<td width="18%" style="padding:6px 8px"></td><td width="32%" style="padding:6px 8px"></td>`);
    rows.push(`<tr>${cell(pairs[i])}${cell(pairs[i + 1])}</tr>`);
  }
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px">${rows.join('')}</table>`;
};

/** Columns: { label, width, align, key } — `key(row)` returns plain text (escaped here) or { raw }. */
const dataTable = (columns, rows, { footer, emptyText = 'No entries' } = {}) => {
  const th = (c) => `<td width="${c.width}" style="padding:7px 8px;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};background-color:${HEAD_BG};font-size:8pt;font-weight:bold;color:${NAVY};text-align:${c.align || 'left'}">${esc(c.label)}</td>`;
  const td = (c, row, zebra) => {
    const value = c.key(row);
    const content = value && typeof value === 'object' && 'raw' in value ? value.raw : esc(value ?? '');
    const color = value && typeof value === 'object' && value.color ? value.color : INK;
    return `<td style="padding:6px 8px;border-bottom:1px solid ${LINE};background-color:${zebra ? ZEBRA : '#ffffff'};font-size:8.5pt;color:${color};text-align:${c.align || 'left'};vertical-align:top">${content}</td>`;
  };
  const body = rows.length
    ? rows.map((row, i) => `<tr style="background-color:${i % 2 ? ZEBRA : '#ffffff'}">${columns.map((c) => td(c, row, i % 2 === 1)).join('')}</tr>`).join('')
    : `<tr><td colspan="${columns.length}" style="padding:12px 8px;border-bottom:1px solid ${LINE};font-size:8.5pt;color:${MUTED};text-align:center">${esc(emptyText)}</td></tr>`;
  const foot = footer
    ? `<tr>${columns.map((c, i) => `<td style="padding:7px 8px;border-top:1.5px solid ${NAVY};border-bottom:1.5px solid ${NAVY};font-size:8.5pt;font-weight:bold;color:${NAVY};text-align:${c.align || 'left'}">${esc(footer[i] ?? '')}</td>`).join('')}</tr>`
    : '';
  return `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px"><tr>${columns.map(th).join('')}</tr>${body}${foot}</table>`;
};

const footnote = (text) => `<p style="margin:16px 0 0;font-size:7.5pt;color:${MUTED}">${esc(text)}</p>`;

const scopeLabel = (bundle) => (bundle.payment ? `Single transaction ${receiptNo(bundle.payment.id)}`
  : bundle.scope === 'documents' ? 'Documents only' : 'Overall statement (all bookings)');

const bankRef = (p) => [p.bank_name, p.cheque_no ? `Chq ${p.cheque_no}` : '', p.transaction_id].filter(Boolean).join(' · ');
const statusText = (p) => {
  const parts = [titleCase(p.status || 'approved')];
  if (p.cheque_status) parts.push(`Chq ${titleCase(p.cheque_status).toLowerCase()}`);
  return parts.join(' · ');
};
const plotSize = (plot) => [plot.plot_size ? `${plot.plot_size} sq yd` : '', plot.plot_size_mtr ? `${plot.plot_size_mtr} sq m` : ''].filter(Boolean).join(' / ');

export const renderStatementHtml = (bundle) => {
  const { plot, site, agents, totals } = bundle;
  const rows = bundle.payment ? [bundle.payment] : bundle.allPayments;
  const title = bundle.payment ? `Transaction ${receiptNo(bundle.payment.id)}` : 'Project Commission Statement';
  const agentNames = agents.map((a) => a.agent_name).filter(Boolean);
  const subtitle = [`Plot ${plot.plot_no}`, agentNames.length ? `Agent ${agentNames.join(', ')}` : 'No agent assigned', plot.buyer_name ? `Buyer ${plot.buyer_name}` : '']
    .filter(Boolean).join(' · ');

  const sum = { gross: 0, tds: 0, net: 0, credit: 0 };
  for (const p of rows) {
    if (!paymentPosts(p)) continue;
    const amount = toNum(p.amount);
    if (amount < 0) sum.credit += -amount;
    else { sum.gross += amount + toNum(p.tds_amount); sum.tds += toNum(p.tds_amount); sum.net += amount; }
  }
  const money = (v) => (v ? moneyINR(v) : '');
  const columns = [
    { label: 'Date', width: '8%', key: (p) => fmtDate(p.date) },
    { label: 'Receipt', width: '8%', key: (p) => receiptNo(p.id) },
    { label: 'Agent', width: '13%', key: (p) => p.agent_name || '' },
    { label: 'Mode', width: '7%', key: (p) => titleCase(p.payment_mode || '') },
    { label: 'Bank / Ref', width: '13%', key: (p) => bankRef(p) },
    { label: 'Gross', width: '9%', align: 'right', key: (p) => (toNum(p.amount) < 0 ? '' : moneyINR(toNum(p.amount) + toNum(p.tds_amount))) },
    { label: 'TDS', width: '7%', align: 'right', key: (p) => (toNum(p.amount) < 0 ? '' : money(toNum(p.tds_amount))) },
    { label: 'Net', width: '9%', align: 'right', key: (p) => (toNum(p.amount) < 0 ? '' : moneyINR(p.amount)) },
    { label: 'Credit', width: '8%', align: 'right', key: (p) => (toNum(p.amount) < 0 ? moneyINR(-toNum(p.amount)) : '') },
    { label: 'Status', width: '8%', key: (p) => ({ raw: esc(statusText(p)), color: paymentPosts(p) ? INK : '#b45309' }) },
    { label: 'Remarks', width: '10%', key: (p) => p.remarks || '' },
  ];
  const footer = ['Total', '', '', '', `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`, moneyINR(sum.gross), moneyINR(sum.tds), moneyINR(sum.net), moneyINR(sum.credit), '', ''];

  const body = headerBand({
    eyebrow: [site.name, site.city].filter(Boolean).join(' · ') || 'Defence Garden Accounts',
    title,
    subtitle,
    rightLabel: 'Statement date',
    rightValue: fmtDate(bundle.generatedAt),
  })
    + metaLine(`Generated ${fmtDateTimeIST(bundle.generatedAt)} by ${bundle.generatedBy}`, `Scope: ${scopeLabel(bundle)}`)
    + tiles([
      { label: 'Decided commission', value: moneyINR(totals.total_commission) },
      { label: 'Paid incl. TDS', value: moneyINR(totals.total_paid) },
      { label: 'TDS held', value: moneyINR(totals.tds_total) },
      { label: 'Balance', value: moneyINR(totals.balance), tone: totals.balance > 0 ? '#b91c1c' : '#15803d' },
      { label: 'Entries', value: String(totals.payment_count) },
    ])
    + sectionTitle('Plot details')
    + kvTable([
      ['Site', [site.name, site.city, site.state].filter(Boolean).join(', ')],
      ['Plot no', plot.plot_no],
      ['Block', plot.block],
      ['Size', plotSize(plot)],
      ['Rate', plot.plot_rate ? moneyINR(plot.plot_rate) : ''],
      ['Sale price', plot.sale_price ? moneyINR(plot.sale_price) : ''],
      ['Buyer', plot.buyer_name],
      ['Booking date', fmtDate(plot.booking_date)],
      ['Plot status', titleCase(plot.status)],
      // plots.commission_rate is a rupee rate (the list shows it as `@ ₹500`), not a percentage.
      ['Commission rate', plot.commission_rate ? `₹ ${moneyINR(plot.commission_rate)}` : ''],
      ['Team', plot.team],
      ['Decided commission', moneyINR(totals.total_commission)],
    ])
    + sectionTitle(agents.length === 1 ? 'Agent' : 'Agents')
    + dataTable([
      { label: 'Name', width: '20%', key: (a) => a.agent_name },
      { label: 'Phone', width: '12%', key: (a) => a.phone },
      { label: 'PAN', width: '12%', key: (a) => a.pan_no },
      { label: 'Bank', width: '26%', key: (a) => [a.bank_name, a.account_no ? `A/c ${a.account_no}` : '', a.ifsc_code].filter(Boolean).join(' · ') },
      { label: 'Decided', width: '10%', align: 'right', key: (a) => moneyINR(a.total_commission) },
      { label: 'Paid', width: '10%', align: 'right', key: (a) => moneyINR(a.total_paid) },
      { label: 'Balance', width: '10%', align: 'right', key: (a) => moneyINR(a.balance) },
    ], agents, { emptyText: 'No agent assigned to this booking' })
    + sectionTitle(bundle.payment ? 'Transaction' : 'Transactions')
    + dataTable(columns, rows, { footer })
    + footnote('Amounts in INR. Negative/credit rows are amounts received back from the agent. Rows shown in amber are awaiting approval or cheque clearance and are excluded from totals. Generated from Defence Garden Accounts.');
  return page(`${title} - Plot ${plot.plot_no}`, body);
};

export const renderProfileHtml = (bundle) => {
  const { plot, site, agents } = bundle;
  const names = agents.map((a) => a.agent_name).filter(Boolean).join(', ') || 'No agent';
  const sections = agents.map((a) => sectionTitle(agents.length > 1 ? `Agent: ${a.agent_name}` : 'Contact')
    + kvTable([
      ['Name', a.agent_name],
      ['Phone', a.phone],
      ['Alternate phone', a.alt_phone],
      ['Email', a.email],
      ['Address', a.address],
      ['Team', a.team],
    ])
    + sectionTitle('Identity')
    + kvTable([
      ['PAN', a.pan_no],
      ['Aadhaar', a.aadhaar_masked],
      ['Licence no', a.license_number],
      ['Default commission rate', a.commission_rate],
    ])
    + sectionTitle('Bank details')
    + kvTable([
      ['Bank', a.bank_name],
      ['Account no', a.account_no],
      ['IFSC', a.ifsc_code],
      ['Branch', a.branch],
    ])
    + sectionTitle(`Commission on Plot ${plot.plot_no}`)
    + tiles([
      { label: 'Decided', value: moneyINR(a.total_commission) },
      { label: 'Paid incl. TDS', value: moneyINR(a.total_paid) },
      { label: 'Balance', value: moneyINR(a.balance), tone: a.balance > 0 ? '#b91c1c' : '#15803d' },
      { label: 'Status', value: titleCase(a.status) || '—' },
    ])
    + (a.remarks ? kvTable([['Remarks', a.remarks]]) : '')).join('');

  const body = headerBand({
    eyebrow: [site.name, site.city].filter(Boolean).join(' · ') || 'Defence Garden Accounts',
    title: 'Agent Profile',
    subtitle: `${names} · Plot ${plot.plot_no}`,
    rightLabel: 'Profile date',
    rightValue: fmtDate(bundle.generatedAt),
  })
    + metaLine(`Generated ${fmtDateTimeIST(bundle.generatedAt)} by ${bundle.generatedBy}`, 'Aadhaar shown masked')
    + (sections || `<p style="margin:16px 0;font-size:9.5pt;color:${MUTED}">No agent is assigned to this booking.</p>`)
    + footnote('Shared from Defence Garden Accounts for accounting purposes. Keep bank and identity details confidential.');
  return page(`Agent Profile - ${names}`, body);
};

/** Preview body for the documents-only scope: just what will land in the Documents folder. */
export const renderDocumentsHtml = (bundle, plan) => {
  const files = plan.filter((f) => f.folder === DOCUMENTS_FOLDER);
  const body = headerBand({
    eyebrow: [bundle.site.name, bundle.site.city].filter(Boolean).join(' · ') || 'Defence Garden Accounts',
    title: 'Documents',
    subtitle: `Plot ${bundle.plot.plot_no} · ${bundle.label}`,
    rightLabel: 'Files',
    rightValue: String(files.filter((f) => !f.skipped_reason).length),
  })
    + metaLine(`Generated ${fmtDateTimeIST(bundle.generatedAt)} by ${bundle.generatedBy}`, `Scope: ${scopeLabel(bundle)}`)
    + sectionTitle('Files to upload')
    + dataTable([
      { label: 'Name', width: '50%', key: (f) => f.name },
      { label: 'Kind', width: '15%', key: (f) => titleCase(f.kind) },
      { label: 'Size', width: '15%', align: 'right', key: (f) => (f.size ? `${(f.size / 1024).toLocaleString('en-IN', { maximumFractionDigits: 0 })} KB` : '') },
      { label: 'Note', width: '20%', key: (f) => ({ raw: esc(f.skipped_reason || ''), color: '#b45309' }) },
    ], files, { emptyText: 'No documents, vouchers or signatures recorded for this plot' });
  return page(`Documents - Plot ${bundle.plot.plot_no}`, body);
};

/* ───────────────────────── XLSX ───────────────────────── */

export const buildStatementXlsx = (bundle) => {
  const { plot, site, agents, totals } = bundle;
  const rows = bundle.payment ? [bundle.payment] : bundle.allPayments;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Project Commission Statement'],
    ['Site', [site.name, site.city, site.state].filter(Boolean).join(', ')],
    ['Plot no', plot.plot_no],
    ['Buyer', plot.buyer_name || ''],
    ['Agents', agents.map((a) => a.agent_name).join(', ')],
    ['Scope', scopeLabel(bundle)],
    ['Generated', fmtDateTimeIST(bundle.generatedAt)],
    ['Generated by', bundle.generatedBy],
    [],
    ['Decided commission', totals.total_commission],
    ['Paid incl. TDS', totals.total_paid],
    ['TDS held', totals.tds_total],
    ['Balance', totals.balance],
    ['Entries', totals.payment_count],
  ]), 'Summary');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Date', 'Receipt', 'Agent', 'Mode', 'Bank', 'Cheque no', 'Transaction id', 'Gross', 'TDS', 'Net', 'Credit', 'TDS section', 'Status', 'Cheque status', 'Posted', 'Remarks', 'Entered by', 'Approved by'],
    ...rows.map((p) => {
      const amount = toNum(p.amount);
      return [
        fmtDate(p.date), receiptNo(p.id), p.agent_name || '', p.payment_mode || '', p.bank_name || '', p.cheque_no || '', p.transaction_id || '',
        amount < 0 ? null : amount + toNum(p.tds_amount), amount < 0 ? null : toNum(p.tds_amount), amount < 0 ? null : amount, amount < 0 ? -amount : null,
        p.tds_section || '', p.status || '', p.cheque_status || '', paymentPosts(p) ? 'Yes' : 'No', p.remarks || '', p.created_by_name || '', p.approved_by_name || '',
      ];
    }),
  ]), 'Transactions');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Name', 'Phone', 'Email', 'PAN', 'Aadhaar (masked)', 'Bank', 'Account no', 'IFSC', 'Branch', 'Decided', 'Paid incl. TDS', 'Balance', 'Status'],
    ...agents.map((a) => [a.agent_name, a.phone, a.email, a.pan_no, a.aadhaar_masked, a.bank_name, a.account_no, a.ifsc_code, a.branch, a.total_commission, a.total_paid, a.balance, a.status]),
  ]), 'Agents');
  // ZIP compression reduces the bytes sent to Drive with a few milliseconds
  // of work locally; no Google Docs conversion is needed for this workbook.
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
};

/* ───────────────────────── Upload plan ───────────────────────── */

const documentFileName = (d) => {
  const base = String(d.title || d.original_name || `Document ${d.id}`).replace(/\.[a-z0-9]{1,5}$/i, '');
  const ext = extOf(d.original_name, EXT_BY_MIME[d.mime_type] || '');
  return `${safeFilePart(base)}${ext ? `.${ext}` : ''}`;
};

export const planShareFiles = (bundle, { scope = bundle.scope || 'overall', formats = ['xlsx'], includeDocuments = false } = {}) => {
  const plan = [];
  const plot = bundle.plot.plot_no;
  const onlyPayment = scope === 'transaction' ? bundle.payment : null;
  const forPayment = (item) => !onlyPayment || Number(item.payment_id) === Number(onlyPayment.id);

  if (scope !== 'documents') {
    const docFormats = formats.filter((f) => f === 'doc' || f === 'pdf');
    const names = bundle.agents.map((a) => a.agent_name).filter(Boolean);
    if (names.length && docFormats.length) {
      plan.push({ folder: PROFILE_FOLDER, name: safeFilePart(`Agent Profile - ${names.join(', ')}`), kind: 'profile', formats: docFormats });
    }
    if (formats.length) {
      const name = onlyPayment ? `Transaction ${receiptNo(onlyPayment.id)} - Plot ${plot}` : `Commission Statement - Plot ${plot}`;
      plan.push({ folder: STATEMENT_FOLDER, name: safeFilePart(name), kind: 'statement', formats: [...formats] });
    }
  }

  if (includeDocuments || scope === 'documents') {
    const docs = onlyPayment ? [] : bundle.documents;
    const names = new Map();
    for (const d of docs) names.set(documentFileName(d), (names.get(documentFileName(d)) || 0) + 1);
    for (const d of docs) {
      const base = documentFileName(d);
      // Same-named uploads would overwrite each other in Drive (upsert by name), so tag duplicates with the row id.
      const name = names.get(base) > 1 ? base.replace(/(\.[a-z0-9]{1,5})?$/i, ` (${d.id})$1`) : base;
      const size = toNum(d.file_size);
      plan.push({
        folder: DOCUMENTS_FOLDER, name, kind: 'document', formats: null, mime_type: d.mime_type || null, size, source: d.file_path,
        ...(size > MAX_FILE_BYTES ? { skipped_reason: 'Larger than 25 MB' } : {}),
      });
    }
    for (const v of bundle.vouchers.filter(forPayment)) {
      plan.push({ folder: DOCUMENTS_FOLDER, name: v.name, kind: 'voucher', formats: null, source: v.url, payment_id: v.payment_id });
    }
    for (const s of bundle.signatures.filter(forPayment)) {
      plan.push({ folder: DOCUMENTS_FOLDER, name: s.name, kind: 'signature', formats: null, source: s.url, payment_id: s.payment_id });
    }
  }
  return plan;
};

/* ───────────────────────── Stored file reads ───────────────────────── */

const sniffMime = (bytes) => {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
};
const tooLarge = (maxBytes) => Object.assign(new Error(`Larger than ${Math.round(maxBytes / 1024 / 1024)} MB`), { code: 'FILE_TOO_LARGE' });

const s3Clients = new Map();
const s3ClientFor = ({ Bucket, region, credentials }) => {
  const key = `${Bucket}:${region}`;
  if (!s3Clients.has(key)) s3Clients.set(key, new S3Client({ region, ...(credentials ? { credentials } : {}) }));
  return s3Clients.get(key);
};

/**
 * Read a stored document/voucher/signature into memory. Only our own storage is
 * reachable: S3 keys and `local::` names via plotDocStorage, https URLs only when
 * they point at a configured bucket. Anything else is refused — voucher URLs are
 * user-supplied, so this must never turn into a generic fetch (SSRF).
 */
export const readStoredFileBytes = async (value, { maxBytes = MAX_FILE_BYTES } = {}) => {
  const ref = String(value || '');
  if (!/^https?:\/\//i.test(ref)) {
    const bytes = await getPlotDocBytes(ref);
    if (bytes.length > maxBytes) throw tooLarge(maxBytes);
    return { bytes, mime_type: sniffMime(bytes) };
  }
  const storage = memberDocumentStorage(ref);
  if (!storage) throw Object.assign(new Error('File is stored outside the app bucket'), { code: 'UNSUPPORTED_STORAGE' });
  const object = await s3ClientFor(storage).send(
    new GetObjectCommand({ Bucket: storage.Bucket, Key: storage.Key }),
    { abortSignal: AbortSignal.timeout(15000) },
  );
  if (object.ContentLength > maxBytes) {
    object.Body?.destroy?.();
    throw tooLarge(maxBytes);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of object.Body) {
    size += chunk.length;
    if (size > maxBytes) {
      object.Body?.destroy?.();
      throw tooLarge(maxBytes);
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  return { bytes, mime_type: object.ContentType && object.ContentType !== 'application/octet-stream' ? object.ContentType : sniffMime(bytes) };
};
