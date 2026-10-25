import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { renderAccountWhatsAppReceipt } from '../src/services/accountWhatsAppDocuments.js';

const payment = {
  full_name: 'Recorded Buyer', site_name: 'Recorded Organization', receipt_no: 'ACK-7788',
  plot_no: 'B24', payment_mode: 'BANK', payment_date: '2026-10-23', amount: 100000.25,
  narration: 'Recorded installment narration', bank_reference: 'RECORDED-UTR', broker_name: 'Recorded Broker',
};
// Standard PDF fonts encode these ASCII assertions directly. Inspect the
// generated page streams rather than only checking renderer inputs.
function pageLines(pdf) {
  const body = pdf.toString('latin1');
  return [...body.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap((match) => {
    let stream;
    try { stream = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { return []; }
    if (!stream.includes('BT')) return [];
    return [...stream.matchAll(/BT\b([\s\S]*?)\bET/g)].map((line) => [...line[1].matchAll(/<([\da-f]+)>/gi)]
      .map((token) => Buffer.from(token[1], 'hex').toString('latin1')).join(''));
  });
}
const pageText = (pdf) => pageLines(pdf).join('');
const render = (variant, { event = 'PAYMENT_RECEIVED', content = {}, fields = {}, ...mode } = {}) => renderAccountWhatsAppReceipt(event, payment, {
  design: { non_cash: { template_id: `official-${variant}`, font_family: 'Helvetica', fields: { qr: false, ...fields }, ...mode, content: { currency_prefix: 'INR ', ...content } } },
});

test('official statements retain saved acknowledgement, direction, purpose and signature labels', async () => {
  for (const variant of ['corporate', 'corporate-mono', 'government', 'legal']) {
    const words = pageText(await render(variant, { content: {
      received_text: 'Acknowledged from', sum_text: 'an amount of', by_text: 'using', towards_text: 'against',
      for_text: 'On behalf of', note_label: 'Saved note', seal_label: 'Saved seal',
      authority_signature_label: 'Saved authority', declaration: 'Saved declaration',
    } }));
    assert.match(words, /Acknowledged from Recorded Buyer an amount of/);
    assert.match(words, /using BANK against Plot Payment/);
    assert.match(words, /On behalf of Recorded Organization/);
    assert.match(words, /Saved authoritySaved seal/);
    assert.match(words, /Saved note: Saved declaration/);
    assert.doesNotMatch(words, /Received with thanks from/);
  }
  const refund = pageText(await render('legal', { event: 'PAYMENT_SENT', content: { paid_text: 'Refunded to' } }));
  assert.match(refund, /Refunded to Recorded Buyer/);
});

test('official invoice renders the saved line headings, narration, total and words instead of generic amount panel', async () => {
  const words = pageText(await render('invoice', { content: {
    sno_label: 'Item number', description_label: 'Saved description', total_label: 'Saved total', words_label: 'Saved words',
    amount_label: 'Saved amount',
  } }));
  assert.match(words, /Item numberSaved descriptionSaved amount1Plot Payment/);
  assert.equal(words.split('Recorded installment narration').length - 1, 1, 'narration belongs to the invoice line, not a duplicate details row');
  assert.match(words, /Saved total/);
  assert.match(words, /Saved words: Rupees One Lakh and Twenty Five Paise Only/);
  assert.doesNotMatch(words, /Credit/);
});

test('counterfoil has a separate office stub with the same receipt identity and editable cashier labels', async () => {
  const words = pageText(await render('counterfoil', { content: {
    counterfoil_label: 'Saved office copy', counterfoil_sign_label: 'Saved cashier',
  } }));
  assert.match(words, /Saved office copy/);
  assert.match(words, /Saved cashier/);
  assert.equal(words.split('ACK-7788').length - 1, 2);
  assert.equal(words.split('Recorded Buyer').length - 1 >= 2, true);
});

test('official fields hidden in the designer stay hidden in the PDF', async () => {
  const words = pageText(await render('counterfoil', { fields: {
    receipt_number: false, party: false, details: false, declaration: false,
    customer_signature: false, authority_signature: false, broker_name: false, copy_label: false,
  } }));
  assert.doesNotMatch(words, /ACK-7788|Recorded Buyer|RECORDED-UTR|Recorded Broker|ORIGINAL|Authorized signatory|Note:/);
});

test('all official variants fit their full front to one configured A5 sheet with long recorded text', async () => {
  for (const variant of ['corporate', 'corporate-mono', 'government', 'counterfoil', 'legal', 'invoice']) {
    const pdf = await render(variant, { page_size: 'A5', content: { address_text: 'Long recorded office address '.repeat(20) } });
    const body = pdf.toString('latin1');
    assert.equal((body.match(/\/Type \/Page\b/g) || []).length, 1, variant);
    assert.match(body, /\/MediaBox \[0 0 419\.5\d* 595\.2\d*\]/);
    assert.match(pageText(pdf), /Recorded Buyer/);
  }
});

test('an A5 official amount stays on one line beside an enabled QR', async () => {
  const pdf = await render('corporate-mono', { page_size: 'A5', fields: { qr: true } });
  assert.equal(pageLines(pdf).some((line) => line === 'INR 1,00,000.25/-'), true);
});
