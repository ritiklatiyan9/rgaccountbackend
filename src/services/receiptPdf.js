import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { loadReceiptImage } from '../utils/receiptImages.js';
import { normalizeReceiptDesign } from './receiptDesign.service.js';

const mm = (value) => value * 72 / 25.4;
const px = (value) => value * 0.75;
const fonts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const text = (value) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
const first = (...values) => values.map(text).find(Boolean) || '';
const money = (value) => Math.abs(Number(value) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const date = (value) => {
  if (!value) return '';
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00+05:30` : value;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? text(value) : parsed.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' });
};
const transactionTime = (value) => {
  const raw = text(value);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(raw)) return raw;
  const [hour, minute, second = '00'] = raw.split(':');
  return `${String(Number(hour) % 12 || 12).padStart(2, '0')}:${minute}:${second} ${Number(hour) < 12 ? 'AM' : 'PM'}`;
};
const chequeDateValue = (value) => {
  const day = String(value ?? '').match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1] || '';
  if (!day) return '';
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : '';
};

export function receiptAmountInWords(value) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`;
  const integer = (n) => {
    if (!n) return 'Zero';
    if (n >= 10000000) return `${integer(Math.floor(n / 10000000))} Crore${n % 10000000 ? ` ${integer(n % 10000000)}` : ''}`;
    if (n >= 100000) return `${two(Math.floor(n / 100000))} Lakh${n % 100000 ? ` ${integer(n % 100000)}` : ''}`;
    if (n >= 1000) return `${two(Math.floor(n / 1000))} Thousand${n % 1000 ? ` ${integer(n % 1000)}` : ''}`;
    if (n >= 100) return `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${two(n % 100)}` : ''}`;
    return two(n);
  };
  const paise = Math.round(Math.abs(Number(value) || 0) * 100);
  return `${integer(Math.floor(paise / 100))}${paise % 100 ? ` and ${integer(paise % 100)} Paise` : ''}`;
}

/** Receipt Studio uses module variations before the shared payment-mode design. */
export function configuredPaymentReceipt(event, data, inputDesign) {
  const design = normalizeReceiptDesign(inputDesign);
  const paymentMode = first(data.payment_mode, data.payment_type).toUpperCase();
  const chequeStatus = text(data.cheque_status).toUpperCase();
  const isCheque = ['CHEQUE', 'CHECK'].includes(paymentMode) || text(data.cheque_no) || ['PENDING', 'CLEARED', 'BOUNCED', 'RETURNED'].includes(chequeStatus);
  const mode = paymentMode === 'CASH' ? 'cash' : isCheque ? 'cheque' : 'non_cash';
  const module = first(data.receipt_module, event === 'INSTALLMENT_RECEIVED' ? 'plot_installment_payment' : 'plot_payment');
  const selected = design.modules[module]?.[mode] || design[mode];
  const content = selected.content;
  const fields = selected.fields;
  const organization = content.organization_text || text(data.site_name);
  const address = content.address_text || first(data.site_address, [data.site_city, data.site_state].filter(Boolean).join(', '));
  const amount = Math.abs(Number(data.amount));
  const moduleLabel = event === 'INSTALLMENT_RECEIVED' ? 'Plot Installment' : 'Plot Payment';
  const values = {
    module: [moduleLabel, data.plot_no && `Plot ${text(data.plot_no)}`].filter(Boolean).join(' · '),
    plot_no: text(data.plot_no), plot_size: /^\d+(?:\.\d+)?$/.test(text(data.plot_size)) ? `${text(data.plot_size)} ${data.unit_type === 'flat' ? 'sq. ft.' : 'sq. yd.'}` : text(data.plot_size),
    plot_rate: Number(data.plot_rate) > 0 ? `₹${money(data.plot_rate)}` : text(data.plot_rate),
    plot_buyer: text(data.full_name), received_by: text(data.received_by), payment_mode: paymentMode,
    reference: [
      first(data.bank_reference, data.transaction_no, data.reference_no, data.reference, data.utr),
      first(data.bank_details, data.bank_account_name),
      [text(data.bank_name), first(data.bank_account_no, data.account_no), text(data.branch)].filter(Boolean).join(' · '),
    ].filter(Boolean).join(' · '),
    narration: first(data.narration, data.particular, data.description, data.details, data.note, data.notes, data.purpose, data.by_note),
    particulars: first(data.particulars, data.particular, data.description, data.details),
    remarks: first(data.remarks, data.remark), remark2: text(data.remark2),
    transaction_time: transactionTime(data.transaction_time), bank_account: first(data.bank_account_name, data.bank_account),
    bank_name: text(data.bank_name), account_no: first(data.bank_account_no, data.account_no), branch: text(data.branch), ifsc: first(data.bank_ifsc, data.ifsc),
    cheque_no: text(data.cheque_no), cheque_status: mode === 'cheque' ? chequeStatus || 'PENDING' : '',
    cheque_apply_date: mode === 'cheque' ? date([data.cheque_apply_date, data.payment_date].map(chequeDateValue).find(Boolean)) : '',
    cheque_transaction_date: mode === 'cheque' ? chequeStatus === 'CLEARED'
      ? date(chequeDateValue(data.cheque_transaction_date)) || 'Not recorded'
      : 'Not cleared' : '',
    booking_reference: first(data.booking_reference, data.booking_no), plot_reference: text(data.plot_reference),
    buyer_phone: text(data.buyer_phone),
    related_party: text(data.related_party), assigned_to: text(data.assigned_to), status: text(data.status),
    category: text(data.category), sub_category: text(data.sub_category),
  };
  const rows = selected.detail_items.filter((item) => item.enabled !== false && (fields.payment_mode || item.key !== 'payment_mode'))
    .map((item) => ({ key: item.key, label: item.label, value: values[item.key] ?? '' }))
    .filter((row) => text(row.value) && text(row.value) !== '—');
  const nameConfig = Object.fromEntries(selected.name_items.map((item) => [item.key, item]));
  const broker = {
    name: text(data.broker_name), phone: text(data.broker_phone), team: text(data.broker_team),
  };
  return {
    mode, module, design: selected, content, fields, organization, address, amount, rows, values, broker, nameConfig,
    direction: event === 'PAYMENT_SENT' ? 'out' : 'in', paymentMode, party: text(data.full_name),
    receiptNo: text(data.receipt_no), date: date(data.payment_date), amountWords: receiptAmountInWords(amount),
    amountText: `${content.currency_prefix}${money(amount)}${content.currency_suffix}`,
    printedAt: data.printed_at || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
  };
}

const layoutOf = (id) => {
  if (id.startsWith('cash-plain-')) return 'plain';
  if (['simple-green', 'simple-office', 'minimal-mono', 'clean-borderless'].includes(id)) return 'minimal';
  if (['teal-modern', 'ocean-blue'].includes(id)) return 'modern';
  if (id.startsWith('official-')) return 'official';
  if (['midnight-corporate', 'azure-stripe', 'ruby-banner'].includes(id)) return 'banner';
  return 'classic';
};

// VoucherUpload accepts documents as well as images. A receipt image section
// must not treat a PDF/DOCX voucher as a signature image or block the receipt.
// PDFKit embeds PNG/JPEG only; without an image conversion dependency, WEBP
// and GIF evidence stays in the source record instead of becoming a fake image.
const unsupportedEvidenceSource = (source) => {
  if (/^data:/i.test(source)) return !/^data:image\/(png|jpeg);base64,/i.test(source);
  let pathname;
  try { pathname = decodeURIComponent(new URL(source, 'https://receipt.invalid').pathname); } catch { return false; }
  return /\.(?:pdf|docx?|xlsx?|pptx?|csv|txt|rtf|odt|zip|webp|gif|heic|heif|avif|svg|tiff?|bmp)$/i.test(pathname);
};
const imageBytes = async (source, { evidence = false } = {}) => {
  if (!source) return null;
  if (evidence && unsupportedEvidenceSource(source)) return null;
  const resolved = await loadReceiptImage(source);
  if (evidence && /^data:image\/(webp|gif);base64,/i.test(resolved || '')) return null;
  if (!/^data:image\/(png|jpeg);base64,/i.test(resolved || '')) throw new Error('The saved receipt image cannot be embedded in the PDF. Use a PNG or JPEG image.');
  return Buffer.from(resolved.slice(resolved.indexOf(',') + 1), 'base64');
};

// Draw from measured operations, then fit the entire front to one physical
// sheet just as the browser printer does. Text is never silently ellipsized.
function pagePlan(doc, receipt) {
  const operations = [];
  const d = receipt.design;
  const regular = /Courier/.test(d.font_family) ? 'Courier' : /Georgia|Garamond|Times/.test(d.font_family) ? 'Times-Roman' : /Arial|Helvetica|Verdana|Trebuchet/.test(d.font_family) ? 'Helvetica' : 'Regular';
  const bold = regular === 'Courier' ? 'Courier-Bold' : regular === 'Times-Roman' ? 'Times-Bold' : regular === 'Helvetica' ? 'Helvetica-Bold' : 'Bold';
  const fontFor = (value, isBold) => /[^\x00-\xff]/.test(value) ? isBold ? 'Bold' : 'Regular' : isBold ? bold : regular;
  const addText = (value, x, y, width, size = px(d.base_font_size), opts = {}) => {
    value = String(value ?? '');
    if (d.text_transform === 'uppercase' && !opts.preserveCase) value = value.toUpperCase();
    if (d.text_transform === 'lowercase' && !opts.preserveCase) value = value.toLowerCase();
    const font = fontFor(value, opts.bold);
    const options = { width, align: opts.align || 'left', lineGap: Math.max(0, size * ((opts.lineHeight || 1.35) * d.line_spacing / 100 - 1)), ...opts };
    doc.font(font).fontSize(size);
    const height = doc.heightOfString(value, options);
    operations.push({ type: 'text', value, x, y, size, font, color: opts.color || d.colors.text, options });
    return height;
  };
  return {
    operations, text: addText,
    line: (x, y, width, color = d.colors.primary, weight = 0.6) => operations.push({ type: 'line', x, y, width, color, weight }),
    box: (x, y, width, height, color, border = '', weight = 0.6) => operations.push({ type: 'box', x, y, width, height, color, border, weight }),
    image: (bytes, x, y, width, height) => bytes && operations.push({ type: 'image', bytes, x, y, width, height }),
  };
}

function presetFront(doc, receipt, assets, { sample, qrDataUrl }) {
  if (receipt.design.template_id.startsWith('official-'))
    return officialFront(doc, receipt, assets, { sample, qrDataUrl });
  const p = pagePlan(doc, receipt);
  const { design: d, content: c, fields: f } = receipt;
  const A5 = d.page_size === 'A5';
  const W = mm(A5 ? 148 : 210), H = mm(A5 ? 210 : 297);
  const left = mm(A5 ? 12 : 18), width = W - left * 2;
  const layout = layoutOf(d.template_id), plain = layout === 'plain';
  const ls = d.line_spacing / 100, base = px(d.base_font_size), gap = (v) => mm(v) * ls;
  const color = d.colors;
  let y = mm(A5 ? 13 : 19);
  const flow = receipt.direction === 'out' ? c.debit_label : c.credit_label;
  const flowColor = receipt.direction === 'out' ? color.debit : color.credit;
  const paragraph = (value, size = base, opts = {}, after = 2) => {
    y += p.text(value, left, y, width, size, opts) + gap(after);
  };
  const copy = sample ? 'SAMPLE - FICTIONAL RECEIPT' : c.original_label;
  if (!['minimal', 'modern', 'plain', 'official'].includes(layout)) p.box(mm(A5 ? 5 : 7), mm(A5 ? 5 : 7), W - mm(A5 ? 10 : 14), H - mm(A5 ? 10 : 14), '', color.primary);
  if (sample || (f.copy_label && !plain)) {
    if (plain) paragraph(copy, base, {}, 2);
    else {
      const badgeWidth = mm(sample ? 56 : 31), badgeY = mm(A5 ? 7 : 9);
      p.box(W - left - badgeWidth, badgeY, badgeWidth, mm(6), color.background, sample ? color.muted : color.primary);
      p.text(copy, W - left - badgeWidth, badgeY + mm(1.5), badgeWidth, px(A5 ? 7.5 : 9), { bold: true, color: color.primary, align: 'center' });
    }
  }
  if (plain) {
    if (f.title) paragraph(c.title, px(d.heading_size), {}, 4);
    if (f.copy_label && !sample) paragraph(c.original_label, base, {}, 2);
    if (f.receipt_number) paragraph(`${c.receipt_number_label}${c.separator}${receipt.receiptNo}`);
    if (f.date) paragraph(`${c.date_label}${c.separator}${receipt.date}`);
    if (f.payment_mode) paragraph(`${c.mode_label}${c.separator}${receipt.paymentMode}`);
    y += gap(3);
  }
  const brokerLines = [
    f.broker_name && receipt.broker.name && `${receipt.nameConfig.broker_name.label}${c.separator}${receipt.broker.name}`,
    f.broker_phone && receipt.broker.phone && `${receipt.nameConfig.broker_phone.label}${c.separator}${receipt.broker.phone}`,
    f.broker_team && receipt.broker.team && `${receipt.nameConfig.broker_team.label}${c.separator}${receipt.broker.team}`,
  ].filter(Boolean);
  if (plain && brokerLines.length) {
    for (const value of brokerLines) paragraph(value);
    y += gap(3);
  }
  if (f.organization || f.address) {
    const align = ['minimal', 'modern', 'plain', 'official'].includes(layout) ? 'left' : 'center';
    if (layout === 'banner') p.box(left - mm(5), y - mm(4), width + mm(10), mm(A5 ? 27 : 32), color.primary);
    if (f.organization) {
      const h = p.text(receipt.organization.toUpperCase(), left, y, width, px(d.heading_size), { bold: !plain, color: layout === 'banner' ? '#ffffff' : color.primary, align });
      y += h + gap(2);
    }
    if (f.address && receipt.address) paragraph(receipt.address, base * 0.72, { color: layout === 'banner' ? '#ffffff' : color.muted, align }, 2);
    if (!plain) { y += gap(A5 ? 2 : 4); p.line(left, y, width); y += gap(2); }
  }
  for (const line of d.info_lines) paragraph(`${line.label}${line.label ? c.separator : ''}${line.value}`, base * 0.8, { color: color.muted }, 1);
  if (!plain && brokerLines.length) {
    paragraph(brokerLines.join(c.contact_separator), base * 0.85, {}, 2);
    p.line(left, y, width, '#d4d9d6');
  }
  if (!plain) {
    y += gap(A5 ? 4 : 6);
    const metaWidth = mm(A5 ? 48 : 61);
    const meta = [f.receipt_number && `${c.receipt_number_label}${c.separator}${receipt.receiptNo}`, f.date && `${c.date_label}${c.separator}${receipt.date}`].filter(Boolean).join('\n');
    const titleH = f.title ? p.text(c.title.toUpperCase(), left, y, width - metaWidth - mm(5), base * (A5 ? 1.08 : 1.25), { bold: true, color: color.primary }) : 0;
    const metaH = meta ? p.text(meta, W - left - metaWidth, y, metaWidth, base * 0.77, { align: 'right', color: color.muted }) : 0;
    y += Math.max(titleH, metaH) + gap(A5 ? 3 : 4);
    p.line(left, y, width, '#d4d9d6');
    y += gap(A5 ? 5 : 8);
  }
  if (f.amount) {
    if (plain) {
      if (f.party && receipt.party) paragraph(`${c.party_label}${c.separator}${receipt.party}`);
      paragraph(`${c.amount_label}${c.separator}${receipt.amountText}`, px(d.amount_size));
      if (f.amount_words) paragraph(`${c.words_prefix}${receipt.amountWords}${c.words_suffix}`);
    } else {
      const start = y, padding = layout === 'minimal' ? 0 : mm(A5 ? 5 : 7);
      const innerWidth = width - padding * 2, align = ['minimal', 'modern'].includes(layout) ? 'left' : 'center';
      y += gap(A5 ? 5 : 7);
      y += p.text(`${c.amount_label} · ${flow}`.toUpperCase(), left + padding, y, innerWidth, base * 0.68, { color: color.muted, bold: true, align }) + gap(1.5);
      y += p.text(receipt.amountText, left + padding, y, innerWidth, px(d.amount_size), { color: flowColor, bold: true, align }) + gap(2);
      if (f.amount_words) y += p.text(`${c.words_prefix}${receipt.amountWords}${c.words_suffix}`, left + padding, y, innerWidth, base * 0.92, { color: color.primary, align }) + gap(2);
      y += gap(A5 ? 3 : 5);
      if (layout === 'minimal') { p.line(left, start, width, '#a8b8ae'); p.line(left, y, width, '#a8b8ae'); }
      else { p.box(left, start, width, y - start, '', color.accent); }
      y += gap(A5 ? 4 : 6);
      if (f.party && receipt.party) paragraph(`${c.party_label}${c.separator}${receipt.party}`, base, { bold: true }, 0);
    }
  } else if (f.party && receipt.party) paragraph(`${c.party_label}${c.separator}${receipt.party}`);
  if (f.details && receipt.rows.length) {
    y += gap(4);
    if (plain) {
      for (const row of receipt.rows) paragraph(`${row.label}${c.separator}${row.value}`);
    } else {
      paragraph(c.details_label.toUpperCase(), base * 0.68, { color: color.accent, bold: true }, 2);
      const labelWidth = width * 0.34, padding = mm(A5 ? 2.5 : 4);
      for (const row of receipt.rows) {
        const rowY = y + gap(A5 ? 2 : 2.8);
        const h1 = p.text(row.label.toUpperCase(), left + padding, rowY, labelWidth - padding * 2, base * 0.7, { color: color.muted });
        const h2 = p.text(row.value, left + labelWidth + padding, rowY, width - labelWidth - padding * 2, base, { bold: true });
        const h = Math.max(h1, h2) + gap(A5 ? 4 : 5.6);
        p.box(left, y, width, h, '', '#d4dcd6', 0.4);
        y += h;
      }
    }
  }
  if (f.evidence && assets.evidence) {
    y += gap(5); p.image(assets.evidence, left, y, mm(A5 ? 36 : 46), mm(A5 ? 24 : 30));
    p.text(`${c.evidence_label}\n${c.evidence_note}`, left + mm(A5 ? 40 : 50), y + mm(3), width - mm(A5 ? 40 : 50), base * 0.75, { color: color.muted });
    y += mm(A5 ? 24 : 30);
  }
  if (f.declaration && c.declaration) {
    y += gap(plain ? 5 : A5 ? 4 : 6);
    paragraph(c.declaration, plain ? base : base * 0.76, { color: plain ? color.text : color.muted, lineHeight: 1.55 }, 0);
  }
  const signatureWidth = plain ? mm(70) : (width - mm(A5 ? 36 : 50)) / 2;
  const imageHeight = mm(A5 ? 9 : 12), signHeight = mm(plain ? 20 : A5 ? 26 : 33);
  if (plain) {
    if (f.qr) {
      y += gap(5);
      const size = mm(A5 ? 26 : 30);
      if (qrDataUrl) p.image(Buffer.from(qrDataUrl.slice(qrDataUrl.indexOf(',') + 1), 'base64'), left, y, size, size);
      else { p.box(left, y, size, size, '', '#bac7be'); p.text(c.qr_placeholder, left, y + mm(10), size, base, { color: color.muted, align: 'center' }); }
      y += size + gap(2);
      paragraph(qrDataUrl ? c.qr_label : c.qr_unavailable, base * 0.75);
    }
    y += gap(7);
    for (const key of ['customer', 'authority']) {
      if (!f[`${key}_signature`]) continue;
      const x = d.template_id === 'cash-plain-slip' ? W - left - signatureWidth : left;
      p.image(assets[key], x, y, signatureWidth, imageHeight);
      y += mm(14);
      y += p.text(key === 'customer' ? c.customer_signature_label : c.authority_signature_label, x, y, signatureWidth, base) + gap(6);
    }
  } else {
    y = Math.max(y + gap(A5 ? 9 : 14), H - mm(A5 ? 11 : 16) - signHeight - (f.printed_at ? mm(14) : 0));
    const signY = y;
    for (const key of ['customer', 'authority']) {
      if (!f[`${key}_signature`]) continue;
      const x = key === 'customer' ? left : W - left - signatureWidth;
      p.image(assets[key], x, signY, signatureWidth, imageHeight);
      p.line(x, signY + imageHeight + mm(1), signatureWidth);
      p.text((key === 'customer' ? c.customer_signature_label : c.authority_signature_label).toUpperCase(), x, signY + imageHeight + mm(2.5), signatureWidth, base * 0.65, { bold: true, color: color.muted, align: 'center' });
    }
    if (f.qr) {
      const qrWidth = mm(A5 ? 26 : 30), x = (W - qrWidth) / 2;
      if (qrDataUrl) p.image(Buffer.from(qrDataUrl.slice(qrDataUrl.indexOf(',') + 1), 'base64'), x, signY - mm(5), qrWidth, qrWidth);
      else {
        p.box(x, signY - mm(5), qrWidth, qrWidth, '', '#bac7be');
        p.text(c.qr_placeholder, x, signY + mm(7), qrWidth, base, { color: color.muted, align: 'center' });
      }
      p.text(qrDataUrl ? c.qr_label : c.qr_unavailable, x - mm(5), signY + qrWidth - mm(3), qrWidth + mm(10), base * 0.58, { color: color.muted, align: 'center' });
    }
    y += signHeight;
  }
  if (f.printed_at) {
    y += gap(4); p.line(left, y, width, '#d4dcd6', 0.4); y += gap(2);
    paragraph(`${c.footer}${c.printed_label}${receipt.printedAt}`, base * (plain ? 1 : 0.6), { color: color.muted, align: plain ? 'left' : 'center' }, 0);
  }
  return { operations: p.operations, width: W, height: H, naturalHeight: Math.max(H, y + mm(A5 ? 11 : 16)) };
}

// The same six document variants as Receipt Design Studio's DOC_VARIANTS.
// Keep their statement/invoice/counterfoil structure and editable labels when
// rendering on the server, rather than falling back to the generic receipt.
function officialFront(doc, receipt, assets, { sample, qrDataUrl }) {
  const p = pagePlan(doc, receipt), { design: d, content: c, fields: f } = receipt;
  const variant = d.template_id.slice('official-'.length);
  const invoice = variant === 'invoice', government = variant === 'government';
  const legal = variant === 'legal', centered = government || legal;
  const A5 = d.page_size === 'A5', W = mm(A5 ? 148 : 210), H = mm(A5 ? 210 : 297);
  const left = mm(A5 ? 10 : 15), width = W - left * 2, base = px(d.base_font_size);
  const gap = (value) => mm(value) * d.line_spacing / 100;
  const border = government ? d.colors.primary : '#9ca3af';
  let y = mm(A5 ? 10 : 14);
  const paragraph = (value, size = base, options = {}, after = 2) => {
    y += p.text(value, left, y, width, size, options) + gap(after);
  };
  const tableRow = (cells, fractions, { header = false, minHeight = 0, fill = '' } = {}) => {
    const top = y, start = p.operations.length, padding = mm(2.5);
    let x = left, height = minHeight;
    cells.forEach((cell, index) => {
      const item = typeof cell === 'object' ? cell : { value: cell };
      const cellWidth = width * fractions[index];
      height = Math.max(height, p.text(item.value || '', x + padding, top + gap(1.6), cellWidth - padding * 2,
        base * (header ? 0.84 : 0.92), { bold: header || item.bold, align: item.align || 'left', color: item.color || d.colors.text }) + gap(3.2));
      x += cellWidth;
    });
    const texts = p.operations.splice(start);
    x = left;
    cells.forEach((cell, index) => {
      const cellWidth = width * fractions[index];
      if (legal && !header) p.line(x, top + height, cellWidth, '#6b7280', 0.5);
      else p.box(x, top, cellWidth, height, fill || (header ? '#f3f4f6' : ''), border, 0.55);
      x += cellWidth;
    });
    p.operations.push(...texts);
    y += height;
  };
  const entry = (key) => receipt.rows.find((row) => row.key === key)?.value || '';
  const party = f.party ? receipt.party : '';
  const payMode = f.payment_mode ? receipt.paymentMode : '';
  const cheque = entry('cheque_no'), purpose = entry('module');
  const instrument = `${payMode}${payMode && cheque ? ` No. ${cheque}` : ''}`;
  const lead = receipt.direction === 'out' ? c.paid_text : c.received_text;
  const broker = f.broker_name ? [receipt.broker.name || c.broker_empty_label,
    f.broker_phone && receipt.broker.phone && `${receipt.nameConfig.broker_phone.label}${c.separator}${receipt.broker.phone}`,
    f.broker_team && receipt.broker.team && `${receipt.nameConfig.broker_team.label}${c.separator}${receipt.broker.team}`,
  ].filter(Boolean).join(c.contact_separator) : '';
  const meta = [
    f.receipt_number && [c.receipt_number_label, receipt.receiptNo],
    f.date && [c.date_label, receipt.date],
    payMode && [c.mode_label, instrument],
    broker && [receipt.nameConfig.broker_name.label, broker],
  ].filter(Boolean);
  if (government) p.box(mm(A5 ? 6 : 9), mm(A5 ? 6 : 9), W - mm(A5 ? 12 : 18), H - mm(A5 ? 12 : 18), '', d.colors.primary);
  if (variant === 'counterfoil') {
    const header = y;
    const nameHeight = f.organization ? p.text(receipt.organization, left, y, width * 0.55, base * 0.86, { bold: true }) : 0;
    const labelHeight = p.text(c.counterfoil_label, left + width * 0.55, y, width * 0.45, base * 0.75, { bold: true, align: 'right', color: d.colors.muted });
    y = header + Math.max(nameHeight, labelHeight) + gap(1.5);
    const stub = [f.receipt_number && [c.receipt_number_label, receipt.receiptNo], f.date && [c.date_label, receipt.date],
      party && [c.party_label, party], f.amount && [c.amount_label, receipt.amountText], [c.counterfoil_sign_label, '']].filter(Boolean);
    const fractions = stub.map(() => 1 / stub.length);
    tableRow(stub.map(([label]) => label), fractions, { header: true });
    tableRow(stub.map(([, value]) => value), fractions, { minHeight: mm(A5 ? 8 : 10) });
    y += gap(4); p.line(left, y, width, '#6b7280', 0.5); y += gap(4);
  }
  const copy = sample ? 'SAMPLE - FICTIONAL RECEIPT' : f.copy_label ? c.original_label : '';
  const headerTop = y, sideWidth = mm(A5 ? 52 : 70), headerGap = mm(6);
  if (centered && copy) {
    y += p.text(copy, left, y, width, base * 0.7, { bold: true, align: 'right' }) + gap(1.5);
  }
  const textWidth = invoice ? width - sideWidth - headerGap : centered ? width : width - (copy ? sideWidth : 0);
  const align = centered ? 'center' : 'left';
  if (f.organization) y += p.text(receipt.organization.toUpperCase(), left, y, textWidth, px(d.heading_size), { bold: true, color: d.colors.primary, align }) + gap(1);
  if (f.address && receipt.address) y += p.text(receipt.address, left, y, textWidth, base * 0.86, { color: d.colors.muted, align }) + gap(1);
  for (const info of d.info_lines) y += p.text(`${info.label}${info.label ? c.separator : ''}${info.value}`, left, y, textWidth, base * 0.8, { align }) + gap(0.8);
  if (!centered) {
    const x = W - left - sideWidth;
    let sideY = headerTop;
    if (copy) sideY += p.text(copy, x, sideY, sideWidth, base * 0.7, { bold: true, align: 'right' }) + gap(1.5);
    if (invoice) {
      if (f.title) {
        const start = p.operations.length;
        const height = p.text(c.title.toUpperCase(), x + mm(3), sideY + gap(1.6), sideWidth - mm(6), base, { bold: true, align: 'center', color: '#ffffff' }) + gap(3.2);
        const titleText = p.operations.splice(start);
        p.box(x, sideY, sideWidth, height, d.colors.primary, d.colors.primary);
        p.operations.push(...titleText); sideY += height;
      }
      for (const [label, value] of meta) {
        const rowTop = sideY;
        const h1 = p.text(label, x + mm(2.5), sideY + gap(1.6), sideWidth * 0.4 - mm(4), base * 0.84, { bold: true });
        const h2 = p.text(value, x + sideWidth * 0.4, sideY + gap(1.6), sideWidth * 0.6 - mm(2.5), base * 0.84, { bold: true, align: 'right' });
        sideY += Math.max(h1, h2) + gap(3.2);
        p.box(x, rowTop, sideWidth, sideY - rowTop, '', d.colors.primary, 0.55);
      }
    }
    y = Math.max(y, sideY);
  }
  y += gap(3); p.line(left, y, width, d.colors.primary, legal ? 1.5 : 1.1); y += gap(3);
  if (!invoice && f.title) {
    if (government) tableRow([{ value: c.title.toUpperCase(), align: 'center' }], [1], { header: true });
    else { paragraph(c.title.toUpperCase(), base * 1.2, { bold: true, align: 'center' }, 3); }
  }
  if (!invoice && meta.length) {
    if (legal) paragraph(meta.map(([label, value]) => `${label}${c.separator}${value}`).join('     '), base * 0.92, {}, 3);
    else { const fractions = meta.map(() => 1 / meta.length); tableRow(meta.map(([label]) => label), fractions, { header: true }); tableRow(meta.map(([, value]) => ({ value, bold: true })), fractions); }
  }
  y += gap(3);
  if (invoice) {
    if (party) { tableRow([`${lead}${c.separator}${party}`], [1]); y += gap(3); }
    tableRow([c.sno_label, c.description_label, { value: c.amount_label, align: 'right' }], [0.1, 0.56, 0.34], { header: true });
    tableRow(['1', [purpose, entry('narration')].filter(Boolean).join(' - ') || c.title,
      { value: f.amount ? receipt.amountText : '', align: 'right' }], [0.1, 0.56, 0.34]);
    tableRow(['', { value: c.total_label, align: 'right', bold: true },
      { value: f.amount ? receipt.amountText : '', align: 'right', bold: true }], [0.1, 0.56, 0.34], { fill: '#f3f4f6' });
    if (f.amount_words) tableRow([`${c.words_label}${c.separator}${c.words_prefix}${receipt.amountWords}${c.words_suffix}`], [1]);
  } else {
    const sum = [f.amount_words && `${c.words_prefix}${receipt.amountWords}${c.words_suffix}`, f.amount && `(${receipt.amountText})`].filter(Boolean).join(' ');
    const statement = `${lead}${party ? ` ${party}` : ''}${sum ? ` ${c.sum_text} ${sum}` : ''}${payMode ? ` ${c.by_text} ${instrument}` : ''}${purpose ? ` ${c.towards_text} ${purpose}` : ''}.`;
    if (government) tableRow([statement], [1]);
    else paragraph(statement, base * (legal ? 1.06 : 1.02), { lineHeight: legal ? 2 : 1.8 }, 3);
  }
  const rows = receipt.rows.filter((row) => !['module', 'payment_mode', ...(invoice ? ['narration'] : [])].includes(row.key));
  if (f.details && rows.length) {
    y += gap(3);
    if (government) {
      tableRow([c.sno_label, c.details_label, c.details_col_label], [0.1, 0.4, 0.5], { header: true });
      rows.forEach((row, index) => tableRow([String(index + 1), { value: row.label, bold: true }, row.value], [0.1, 0.4, 0.5]));
    } else {
      paragraph(c.details_label.toUpperCase(), base * 0.82, { bold: true, color: d.colors.primary }, 1.5);
      for (let index = 0; index < rows.length; index += legal ? 1 : 2) {
        const row = rows[index], next = rows[index + 1];
        if (legal || !next) tableRow([{ value: row.label, bold: true }, row.value], [legal ? 0.35 : 0.19, legal ? 0.65 : 0.81]);
        else tableRow([{ value: row.label, bold: true }, row.value, { value: next.label, bold: true }, next.value], [0.19, 0.31, 0.19, 0.31]);
      }
    }
  }
  if (f.evidence && assets.evidence) {
    y += gap(4); const imageHeight = mm(A5 ? 24 : 30), imageWidth = mm(A5 ? 36 : 46);
    p.image(assets.evidence, left, y, imageWidth, imageHeight);
    const labelHeight = p.text(`${c.evidence_label}\n${c.evidence_note}`, left + imageWidth + mm(4), y + mm(2), width - imageWidth - mm(4), base * 0.75);
    y += Math.max(imageHeight, labelHeight);
  }
  if ((f.amount && !invoice) || f.qr) {
    y += gap(4); const top = y, qrSize = mm(A5 ? 20 : 24), amountWidth = width - (f.qr ? qrSize + mm(6) : 0);
    if (f.amount && !invoice) {
      doc.font('Bold').fontSize(px(d.amount_size));
      const labelWidth = Math.min(mm(38), amountWidth * 0.34);
      const boxWidth = Math.min(amountWidth, labelWidth + doc.widthOfString(receipt.amountText) + mm(8));
      const start = p.operations.length;
      const numberWidth = boxWidth - labelWidth - mm(8);
      const amountSize = Math.min(px(d.amount_size), px(d.amount_size) * numberWidth / doc.widthOfString(receipt.amountText) * 0.99);
      const amountHeight = p.text(receipt.amountText, left + labelWidth + mm(4), top + mm(1.5), numberWidth, amountSize, { bold: true });
      const labelHeight = p.text(c.amount_label.toUpperCase(), left + mm(3), top + mm(2), labelWidth - mm(6), base * 0.78, { bold: true });
      const height = Math.max(amountHeight + mm(3), labelHeight + mm(4));
      p.operations.at(-1).y = top + (height - labelHeight) / 2;
      const labels = p.operations.splice(start);
      p.box(left, top, labelWidth, height, '#f3f4f6', d.colors.text, 1);
      p.box(left + labelWidth, top, boxWidth - labelWidth, height, '', d.colors.text, 1);
      p.operations.push(...labels); y += height;
    }
    if (f.qr) {
      const x = W - left - qrSize;
      if (qrDataUrl) p.image(Buffer.from(qrDataUrl.slice(qrDataUrl.indexOf(',') + 1), 'base64'), x, top, qrSize, qrSize);
      else { p.box(x, top, qrSize, qrSize, '', '#bac7be'); p.text(c.qr_placeholder, x, top + qrSize / 2 - base / 2, qrSize, base, { align: 'center' }); }
      const labelHeight = p.text(qrDataUrl ? c.qr_label : c.qr_unavailable, x - mm(3), top + qrSize + mm(0.8), qrSize + mm(6), base * 0.62, { align: 'center', color: d.colors.muted });
      y = Math.max(y, top + qrSize + mm(0.8) + labelHeight);
    }
  }
  if (f.customer_signature || f.authority_signature) {
    y += gap(A5 ? 8 : 12); const top = y, signatureWidth = mm(A5 ? 42 : 56), imageHeight = mm(A5 ? 9 : 12);
    const forHeight = f.authority_signature && f.organization && receipt.organization
      ? p.text(`${c.for_text} ${receipt.organization}`, W - left - signatureWidth, top, signatureWidth, base * 0.8, { align: 'center' }) + mm(1) : 0;
    for (const key of ['customer', 'authority']) {
      if (!f[`${key}_signature`]) continue;
      const x = key === 'authority' || !f.authority_signature ? W - left - signatureWidth : left;
      let signY = top + forHeight;
      p.image(assets[key], x, signY, signatureWidth, imageHeight); signY += imageHeight + mm(1);
      p.line(x, signY, signatureWidth, '#6b7280', 0.5); signY += mm(2);
      signY += p.text(key === 'customer' ? c.customer_signature_label : c.authority_signature_label, x, signY, signatureWidth, base * 0.8, { align: 'center' });
      if (key === 'authority' && f.seal) signY += mm(1) + p.text(c.seal_label, x, signY + mm(1), signatureWidth, base * 0.7, { align: 'center', color: d.colors.muted });
      y = Math.max(y, signY);
    }
  }
  if (f.declaration && c.declaration) { y += gap(4); paragraph(`${c.note_label}${c.separator}${c.declaration}`, base * 0.86, {}, 0); }
  if (f.printed_at) { y += gap(4); paragraph(`${c.footer}${c.printed_label}${receipt.printedAt}`, base * 0.65, { color: d.colors.muted }, 0); }
  return { operations: p.operations, width: W, height: H, naturalHeight: Math.max(H, y + mm(A5 ? 9 : 12)) };
}

function backPage(doc, receipt) {
  const p = pagePlan(doc, receipt), d = receipt.design, back = d.back_page;
  const A5 = d.page_size === 'A5', W = mm(A5 ? 148 : 210), H = mm(A5 ? 210 : 297), left = mm(A5 ? 12 : 18), width = W - left * 2;
  let y = mm(A5 ? 13 : 19);
  const base = px(d.base_font_size), gap = mm(3) * d.line_spacing / 100;
  if (receipt.fields.organization) y += p.text(receipt.organization, left, y, width * 0.6, base, { bold: true }) + gap;
  if (receipt.fields.receipt_number) p.text(`${receipt.content.receipt_number_label}${receipt.content.separator}${receipt.receiptNo}`, left, mm(A5 ? 13 : 19), width, base * 0.75, { align: 'right' });
  y += gap; p.line(left, y, width); y += gap * 2;
  if (back.title) y += p.text(back.title, left, y, width, px(d.heading_size), { bold: true }) + gap * 2;
  if (back.intro) y += p.text(back.intro, left, y, width, base) + gap * 2;
  const terms = back.terms.split('\n').map((term) => term.replace(/^\s*(?:\d+\s*[.)]|[-•*])\s*/, '').trim()).filter(Boolean);
  const columns = back.two_columns ? 2 : 1, colGap = mm(6), colWidth = (width - colGap * (columns - 1)) / columns;
  const top = y;
  const heights = [y, y];
  const split = Math.ceil(terms.length / columns);
  terms.forEach((term, index) => {
    const col = Math.floor(index / split), x = left + col * (colWidth + colGap);
    heights[col] += p.text(`${index + 1}. ${term}`, x, heights[col], colWidth, base * 0.85) + gap;
  });
  y = Math.max(top, ...heights) + gap * 2;
  if (back.acknowledgement) {
    y += p.text(back.acknowledgement, left, y, width, base * 0.9) + mm(20);
    p.line(left, y, width * 0.6); p.line(left + width * 0.75, y, width * 0.25);
    y += gap;
    p.text(back.signature_label, left, y, width * 0.6, base * 0.8);
    y += p.text(receipt.content.date_label, left + width * 0.75, y, width * 0.25, base * 0.8) + gap;
  }
  if (back.footer) y += p.text(back.footer, left, y + gap, width, base * 0.7);
  return { operations: p.operations, width: W, height: H, naturalHeight: Math.max(H, y + mm(16)) };
}

async function canvasPage(doc, receipt, assets, { sample, qrDataUrl }) {
  const p = pagePlan(doc, receipt), d = receipt.design;
  const W = mm(d.page_size === 'A5' ? 148 : 210), H = mm(d.page_size === 'A5' ? 210 : 297);
  const values = { ...receipt.values, organization: receipt.organization, address: receipt.address, receipt_number: receipt.receiptNo, date: receipt.date,
    party: receipt.party, amount: money(receipt.amount), amount_words: receipt.amountWords, direction: receipt.direction === 'out' ? receipt.content.debit_label : receipt.content.credit_label,
    payment_mode: receipt.paymentMode, printed_at: receipt.printedAt, broker_name: receipt.broker.name, broker_phone: receipt.broker.phone, broker_team: receipt.broker.team };
  for (const item of d.elements.filter((item) => !item.hidden)) {
    const x = mm(item.x), y = mm(item.y), w = mm(item.width), h = mm(item.height);
    if (x + w > W + 0.1 || y + h > H + 0.1) throw new Error('Receipt content extends beyond the paper. Move or resize the elements in Receipt Design Studio before sending.');
    if (item.background !== 'transparent' || item.border_width) p.box(x, y, w, h, item.background === 'transparent' ? '' : item.background, item.border_width ? item.border_color : '', mm(item.border_width));
    if (item.type === 'line') { p.line(x, y, w, item.border_color, mm(item.border_width)); continue; }
    if (item.type === 'box') continue;
    if (item.type === 'image') { p.image(item.field === 'evidence' ? assets.evidence : await imageBytes(item.src), x, y, w, h); continue; }
    if (item.type === 'customer_signature' || item.type === 'authority_signature') { p.image(assets[item.type.split('_')[0]], x, y, w, h); continue; }
    if (item.type === 'qr') {
      if (qrDataUrl) p.image(Buffer.from(qrDataUrl.slice(qrDataUrl.indexOf(',') + 1), 'base64'), x, y, w, Math.min(w, h));
      else p.text(receipt.content.qr_unavailable, x, y, w, px(item.font_size));
      continue;
    }
    const value = values[item.field] ?? '';
    if (item.type === 'field' && item.hide_empty !== false && value === '') continue;
    const body = item.type === 'field' ? `${item.prefix}${value}${item.suffix}` : item.type === 'copy_label' ? sample ? 'SAMPLE - FICTIONAL RECEIPT' : receipt.content.original_label : item.type === 'details' ? receipt.rows.map((row) => `${row.label}${item.prefix || ': '}${row.value}`).join('\n\n') : item.text.replace(/\{\{([a-z0-9_]+)\}\}/g, (_, key) => values[key] ?? '');
    const actualHeight = p.text(body, x, y, w, px(item.font_size), { bold: item.bold, align: item.align, color: item.color, lineHeight: 1.3 });
    if (y + actualHeight > H + 0.1) throw new Error('Receipt text extends beyond the paper. Resize the elements in Receipt Design Studio before sending.');
  }
  if (sample) p.text('SAMPLE - FICTIONAL DETAILS', mm(4), H - mm(6), W - mm(8), 6, { color: '#64748b', align: 'center' });
  return { operations: p.operations, width: W, height: H, naturalHeight: H };
}

export async function renderConfiguredPaymentReceiptPdf(receipt, data, options = {}) {
  const d = receipt.design;
  const assets = {
    customer: d.fields.customer_signature ? await imageBytes(data.customer_signature_url) : null,
    authority: d.fields.authority_signature ? await imageBytes(data.authority_signature_url) : null,
    evidence: d.fields.evidence ? await imageBytes(first(data.evidence_photo_url, data.voucher_url), { evidence: true }) : null,
  };
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({ size: d.page_size, margin: 0, bufferPages: true, info: { Title: `${receipt.content.title.trim()} ${receipt.receiptNo}`, Author: receipt.organization } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      doc.registerFont('Regular', path.join(fonts, 'Figtree-Regular.ttf'));
      doc.registerFont('Bold', path.join(fonts, 'Figtree-Bold.ttf'));
      // Explicit measured drawing handles wrapping. Prevent PDFKit's separate
      // automatic page flow from creating blank pages inside scaled sheets.
      doc.page.margins.bottom = -100000;
      const front = d.layout_mode === 'canvas' ? await canvasPage(doc, receipt, assets, options) : presetFront(doc, receipt, assets, options);
      const pages = [front, ...(d.back_page.enabled ? [backPage(doc, receipt)] : [])];
      for (const [index, plan] of pages.entries()) {
        if (index) { doc.addPage({ size: d.page_size, margin: 0 }); doc.page.margins.bottom = -100000; }
        doc.rect(0, 0, plan.width, plan.height).fill(d.colors.background);
        const scale = Math.min(1, (plan.height - 1) / plan.naturalHeight);
        doc.save().translate((plan.width - plan.width * scale) / 2, 0).scale(scale);
        for (const operation of plan.operations) {
          const { type, x, y, width, height } = operation;
          if (type === 'text') doc.font(operation.font).fontSize(operation.size).fillColor(operation.color).text(operation.value, x, y, operation.options);
          if (type === 'line') doc.moveTo(x, y).lineTo(x + width, y).lineWidth(operation.weight).strokeColor(operation.color).stroke();
          if (type === 'box') {
            doc.rect(x, y, width, height).lineWidth(operation.weight);
            if (operation.color && operation.border) doc.fillAndStroke(operation.color, operation.border);
            else if (operation.color) doc.fill(operation.color);
            else if (operation.border) doc.stroke(operation.border);
          }
          if (type === 'image') doc.image(operation.bytes, x, y, { fit: [width, height], align: 'center', valign: 'center' });
        }
        doc.restore();
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}
