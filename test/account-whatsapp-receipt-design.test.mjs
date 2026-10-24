import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredPaymentReceipt, receiptAmountInWords } from '../src/services/receiptPdf.js';
import { renderAccountWhatsAppReceipt } from '../src/services/accountWhatsAppDocuments.js';
import { getReceiptDesignWithScope, normalizeReceiptDesign, RECEIPT_DESIGN_KEY, RECEIPT_SITE_DESIGN_KEY } from '../src/services/receiptDesign.service.js';

const payment = {
  full_name: 'Fictional Preview Buyer', site_name: 'OM ASSOCIATES', site_address: 'Preview office address',
  receipt_no: 'ACK-SAMPLE-1', plot_no: 'A-18', plot_size: '120 sq. yd.', plot_rate: 2000,
  payment_mode: 'BANK', payment_date: '2026-10-24', amount: 100000.25,
  bank_reference: 'REAL-REF', narration: 'Recorded transaction narration', broker_name: 'Recorded Consultant',
};

const omDesign = normalizeReceiptDesign({
  non_cash: { template_id: 'executive-classic', content: { title: 'Shared receipt' } },
  cheque: { template_id: 'minimal-mono', font_family: 'Courier New', fields: { qr: false }, content: { title: 'Cheque Receipt' } },
  cash: { template_id: 'cash-plain-note', page_size: 'A5', fields: { qr: false } },
  modules: {
    plot_payment: {
      non_cash: {
        template_id: 'simple-green', page_size: 'A4', base_font_size: 13, line_spacing: 90,
        heading_size: 28, amount_size: 43, fields: { qr: false, printed_at: false },
        content: { title: 'OM Payment Receipt', party_label: 'Buyer Name ', organization_text: 'OM ASSOCIATES' },
        detail_items: [
          { key: 'plot_no', label: 'Property number', sample: 'FAKE-PLOT', enabled: true },
          { key: 'reference', label: 'Reference', sample: 'FAKE-REF', enabled: false },
          { key: 'narration', label: 'Narration', sample: 'FAKE-NARRATION', enabled: true },
          { key: 'module', label: 'Module', enabled: false },
        ],
      },
      cash: { template_id: 'cash-plain-note', page_size: 'A4', base_font_size: 15, heading_size: 15, amount_size: 17,
        fields: { organization: false, address: false, payment_mode: false, qr: false, printed_at: false },
        content: { party_label: 'Buyer', authority_signature_label: 'Authorized Consultant' } },
    },
  },
});

test('received-payment PDF selects the saved OM module variation, labels and real recorded values', () => {
  const receipt = configuredPaymentReceipt('PAYMENT_RECEIVED', payment, omDesign);
  assert.equal(receipt.module, 'plot_payment');
  assert.equal(receipt.design.template_id, 'simple-green');
  assert.equal(receipt.design.page_size, 'A4');
  assert.equal(receipt.content.title, 'OM Payment Receipt');
  assert.equal(receipt.content.party_label, 'Buyer Name ');
  assert.equal(receipt.organization, 'OM ASSOCIATES');
  assert.equal(receipt.fields.qr, false);
  assert.equal(receipt.design.line_spacing, 90);
  assert.equal(receipt.rows.find((row) => row.key === 'plot_no').label, 'Property number');
  assert.equal(receipt.rows.find((row) => row.key === 'plot_no').value, 'A-18');
  assert.equal(receipt.rows.find((row) => row.key === 'narration').value, payment.narration);
  assert.equal(receipt.rows.some((row) => row.key === 'reference' || row.key === 'module'), false);
  assert.doesNotMatch(JSON.stringify(receipt.rows), /FAKE/);
  assert.equal(receipt.amountText, '₹ 1,00,000.25/-');
  assert.equal(receipt.amountWords, 'One Lakh and Twenty Five Paise');
  assert.equal(receipt.date, '24/10/2026');
});

test('all payment modes use their own format; installment receipts inherit their own module', () => {
  assert.equal(configuredPaymentReceipt('PAYMENT_RECEIVED', { ...payment, payment_mode: 'CHECK' }, omDesign).mode, 'cheque');
  assert.equal(configuredPaymentReceipt('PAYMENT_RECEIVED', { ...payment, payment_mode: 'BANK', cheque_no: '000123' }, omDesign).design.template_id, 'minimal-mono');
  const cash = configuredPaymentReceipt('PAYMENT_RECEIVED', { ...payment, payment_mode: 'CASH' }, omDesign);
  assert.equal(cash.design.page_size, 'A4');
  assert.equal(cash.design.template_id, 'cash-plain-note');
  assert.equal(cash.fields.organization, false);
  assert.equal(cash.content.authority_signature_label, 'Authorized Consultant');
  assert.equal(configuredPaymentReceipt('INSTALLMENT_RECEIVED', payment, omDesign).content.title, 'Shared receipt');
  const refund = configuredPaymentReceipt('PAYMENT_SENT', { ...payment, amount: -100000.25 }, omDesign);
  assert.equal(refund.direction, 'out');
  assert.equal(refund.amount, 100000.25);
});

test('recorded bank particulars and narration use the same fallbacks as printed receipts', () => {
  const receipt = configuredPaymentReceipt('PAYMENT_RECEIVED', {
    ...payment, plot_size: '950', unit_type: 'flat', transaction_time: '14:25:00', narration: '',
    details: 'Recorded details', bank_details: 'Recorded bank description', bank_name: 'Sample Bank', account_no: '00001234', branch: 'Sample branch',
  }, omDesign);
  assert.equal(receipt.values.plot_size, '950 sq. ft.');
  assert.equal(receipt.values.transaction_time, '02:25:00 PM');
  assert.equal(receipt.values.reference, 'REAL-REF · Recorded bank description · Sample Bank · 00001234 · Sample branch');
  assert.equal(receipt.values.narration, 'Recorded details');
  assert.equal(receipt.values.particulars, 'Recorded details');
});

test('buyer contact and cheque lifecycle dates match the canonical print rules', () => {
  const receipt = configuredPaymentReceipt('PAYMENT_RECEIVED', {
    ...payment, payment_mode: 'CHEQUE', cheque_status: 'CLEARED', buyer_phone: '0000000000',
  }, omDesign);
  assert.equal(receipt.values.buyer_phone, '0000000000');
  assert.equal(receipt.values.cheque_apply_date, '24/10/2026');
  assert.equal(receipt.values.cheque_transaction_date, 'Not recorded');
  const recorded = configuredPaymentReceipt('PAYMENT_RECEIVED', {
    ...payment, payment_mode: 'CHEQUE', cheque_status: 'CLEARED', cheque_apply_date: '2026-10-20', cheque_transaction_date: '2026-10-23',
  }, omDesign);
  assert.equal(recorded.values.cheque_apply_date, '20/10/2026');
  assert.equal(recorded.values.cheque_transaction_date, '23/10/2026');
  const pending = configuredPaymentReceipt('PAYMENT_RECEIVED', {
    ...payment, payment_mode: 'CHEQUE', cheque_status: 'PENDING', cheque_apply_date: '2026-02-30', cheque_transaction_date: '2026-10-23',
  }, omDesign);
  assert.equal(pending.values.cheque_apply_date, '24/10/2026');
  assert.equal(pending.values.cheque_transaction_date, 'Not cleared');
  assert.equal(configuredPaymentReceipt('PAYMENT_RECEIVED', { ...payment, cheque_status: 'CLEARED' }, omDesign).mode, 'cheque');
  assert.equal(configuredPaymentReceipt('PAYMENT_RECEIVED', payment, omDesign).values.cheque_apply_date, '');
});

test('configured PDF has actual paper size, whole front, and optional reverse terms sheet', async () => {
  const design = structuredClone(omDesign);
  design.modules.plot_payment.non_cash.page_size = 'A5';
  design.modules.plot_payment.non_cash.back_page = { enabled: true, terms: 'First saved condition\nSecond saved condition', two_columns: true };
  const bytes = await renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', { ...payment, narration: 'Long recorded particulars '.repeat(120) }, { design, sample: true });
  assert.match(bytes.subarray(0, 8).toString(), /%PDF/);
  const body = bytes.toString('latin1');
  assert.equal((body.match(/\/Type \/Page\b/g) || []).length, 2);
  assert.match(body, /\/MediaBox \[0 0 419\.5\d* 595\.2\d*\]/);
  assert.doesNotMatch(body, /\/JavaScript|\/Launch/);
});

test('document vouchers do not block the payment receipt or become receipt images', async () => {
  for (const voucher_url of [
    'https://private-bucket.s3.us-east-1.amazonaws.com/vouchers/recorded-proof.pdf?signature=example',
    'https://private-bucket.s3.us-east-1.amazonaws.com/vouchers/recorded-proof.DOCX',
    'data:application/pdf;base64,JVBERi0xLjc=',
  ]) {
    const bytes = await renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', { ...payment, voucher_url }, { design: omDesign });
    assert.match(bytes.subarray(0, 8).toString(), /%PDF/);
    assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1);
    assert.doesNotMatch(bytes.toString('latin1'), /\/Subtype \/Image/);
  }
});

test('WEBP evidence is omitted without a conversion dependency and never blocks its receipt', async () => {
  const webp = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
  for (const voucher_url of [webp, 'https://private-bucket.s3.us-east-1.amazonaws.com/vouchers/photo.webp']) {
    const bytes = await renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', { ...payment, voucher_url }, { design: omDesign });
    assert.match(bytes.subarray(0, 8).toString(), /%PDF/);
    assert.doesNotMatch(bytes.toString('latin1'), /\/Subtype \/Image/);
  }
  await assert.rejects(renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', { ...payment, customer_signature_url: webp }, { design: omDesign }), /Use a PNG or JPEG/);
});

test('corrupted PNG evidence and saved signatures still fail explicitly', async () => {
  const corruptImage = 'data:image/png;base64,bm90LWFuLWltYWdl';
  await assert.rejects(renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', { ...payment, evidence_photo_url: corruptImage }, { design: omDesign }), /image|PNG/i);
  await assert.rejects(renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', { ...payment, authority_signature_url: corruptImage }, { design: omDesign }), /image|PNG/i);
});

test('canvas overflow fails instead of silently clipping a payment receipt', async () => {
  const design = structuredClone(omDesign);
  design.modules.plot_payment.non_cash.layout_mode = 'canvas';
  design.modules.plot_payment.non_cash.elements = [{ id: 'bad', type: 'text', x: 205, y: 20, width: 100, height: 10, text: 'Does not fit' }];
  await assert.rejects(renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', payment, { design }), /extends beyond the paper/);
});

test('receipt design read is injectable and retains per-site precedence without any writes', async () => {
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    assert.match(sql, /^SELECT/);
    if (params.includes(RECEIPT_SITE_DESIGN_KEY)) return { rows: [{ setting_value: { non_cash: { content: { title: 'Site override' } } } }] };
    throw Error('A site override must not load shared settings');
  } };
  const result = await getReceiptDesignWithScope(5, db);
  assert.equal(result.scope, 'site');
  assert.equal(result.design.non_cash.content.title, 'Site override');
  assert.equal(calls.length, 1);
  const shared = await getReceiptDesignWithScope(5, { async query(sql, params) {
    assert.match(sql, /^SELECT/);
    return { rows: params[0] === RECEIPT_DESIGN_KEY ? [{ setting_value: omDesign }] : [] };
  } });
  assert.equal(shared.scope, 'global');
  assert.equal(shared.design.modules.plot_payment.non_cash.template_id, 'simple-green');
});

test('amount words preserve paise and large amounts without substituting design samples', () => {
  assert.equal(receiptAmountInWords(0), 'Zero');
  assert.equal(receiptAmountInWords(12500000.5), 'One Crore Twenty Five Lakh and Fifty Paise');
  assert.equal(receiptAmountInWords(-1000), 'One Thousand');
});
