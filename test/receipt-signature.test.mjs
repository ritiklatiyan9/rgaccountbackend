import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import sharp from 'sharp';
import settings from '../src/models/ApplicationSetting.model.js';
import { createReceiptSignatureRouter } from '../src/routes/receiptSignature.routes.js';
import { normalizeReceiptSignature, prepareReceiptSignature, RECEIPT_SIGNATURE_KEY, MAX_SIGNATURE_BYTES } from '../src/services/receiptSignature.service.js';
import { configuredPaymentReceipt, renderConfiguredPaymentReceiptPdf } from '../src/services/receiptPdf.js';

const signatureBitmap = async (format = 'png', transparent = false) => sharp({ create: { width: 1000, height: 500, channels: 4, background: transparent ? '#ffffff00' : '#ffffff' } })
  .composite([{ input: await sharp({ create: { width: 400, height: 80, channels: 4, background: '#102550' } }).png().toBuffer(), left: 300, top: 210 }])
  [format]().toBuffer();
const file = (buffer, name = 'sign.png', type = 'image/png') => ({ buffer, originalname: name, mimetype: type });

async function requestApp(app, suffix, options) {
  const encoded = new Request(`http://receipt.test/signature${suffix}`, options);
  const payload = Buffer.from(await encoded.arrayBuffer());
  return new Promise((resolve, reject) => {
    const socket = new PassThrough(), req = new IncomingMessage(socket);
    req.method = encoded.method; req.url = `/signature${suffix}`;
    req.httpVersion = '1.1'; req.httpVersionMajor = 1; req.httpVersionMinor = 1; req.complete = true;
    req.headers = Object.fromEntries(encoded.headers);
    if (payload.length) req.headers['content-length'] = String(payload.length);
    const res = new ServerResponse(req), chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Signature request timed out')); }, 3000);
    socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
    res.assignSocket(socket); res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString();
      let text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      if (res.getHeader('transfer-encoding') === 'chunked' || /transfer-encoding: chunked/i.test(raw)) {
        let remaining = text; text = '';
        while (remaining.length) {
          const end = remaining.indexOf('\r\n'), size = Number.parseInt(remaining.slice(0, end), 16);
          if (!size) break;
          text += remaining.slice(end + 2, end + 2 + size); remaining = remaining.slice(end + 2 + size + 2);
        }
      }
      const body = text ? JSON.parse(text) : null;
      resolve({ status: res.statusCode, json: async () => body }); socket.destroy();
    });
    app.handle(req, res); if (payload.length) req.push(payload); req.push(null);
  });
}

test('PNG, JPG and JPEG signatures trim empty margins and keep proportions within print bounds', async () => {
  for (const [format, extension, transparent] of [['png', 'PNG', false], ['png', 'png', true], ['jpeg', 'jpg', false], ['jpeg', 'jpeg', false]]) {
    const prepared = await prepareReceiptSignature(file(await signatureBitmap(format, transparent), `sign.${extension}`, format === 'png' ? 'image/png' : 'image/jpeg'));
    const metadata = await sharp(Buffer.from(prepared.image_data_url.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.format, 'png');
    assert.ok(metadata.width <= 1200 && metadata.height <= 360);
    assert.ok(Math.abs(metadata.width / metadata.height - 5) < 0.2, 'empty paper does not make the signature tiny');
    assert.equal(metadata.hasAlpha, true);
  }
});

test('renamed files, corrupt images, unsupported formats and oversized uploads are rejected', async () => {
  await assert.rejects(prepareReceiptSignature(file(Buffer.from('<svg>not an image</svg>'))), /valid PNG/);
  const png = await signatureBitmap();
  await assert.rejects(prepareReceiptSignature(file(png, 'document.pdf', 'image/png')), /PNG, JPG or JPEG/);
  const gif = await sharp(png).gif().toBuffer();
  await assert.rejects(prepareReceiptSignature(file(gif)), /valid PNG/);
  await assert.rejects(prepareReceiptSignature(file(Buffer.alloc(MAX_SIGNATURE_BYTES + 1))), /5 MB/);
  await assert.rejects(prepareReceiptSignature(), /Choose a signature/);
});

test('older signatures retain standard size and stored percentages stay within print limits', () => {
  assert.equal(normalizeReceiptSignature({}).size_percent, 100);
  assert.equal(normalizeReceiptSignature({ size_percent: 150 }).size_percent, 150);
  assert.equal(normalizeReceiptSignature({ size_percent: 1 }).size_percent, 50);
  assert.equal(normalizeReceiptSignature({ size_percent: 500 }).size_percent, 200);
  assert.equal(normalizeReceiptSignature({ size_percent: '150' }).size_percent, 100);
});

test('upload, enable, replace, disable and remove persist independently for each site', async t => {
  const stored = new Map();
  const database = { query: async (sql, params) => {
    if (sql.includes('FROM sites')) return { rows: params[1] === 9 && [1, 2].includes(params[0]) ? [{ id: params[0] }] : [] };
    if (sql.includes('FROM user_sites')) return { rows: params[1] === 1 ? [{}] : [] };
    return { rows: stored.has(params[0]) ? [{ setting_value: stored.get(params[0]) }] : [] };
  } };
  t.mock.method(settings, 'setJson', async (siteId, key, value, by) => {
    assert.equal(key, RECEIPT_SIGNATURE_KEY); assert.equal(by, 7);
    stored.set(siteId, value); return value;
  });
  const app = express();
  app.use(express.json());
  app.use('/signature', createReceiptSignatureRouter({ database, authenticate: (req, _res, next) => {
    req.user = { id: 7, organization_id: Number(req.get('test-org') || 9), role: req.get('test-role') || 'admin' }; next();
  } }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const request = (suffix = '?site_id=1', options) => requestApp(app, suffix, options);
  const toggle = enabled => request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: 1, enabled }) });
  const resize = size_percent => request('', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site_id: 1, size_percent }) });
  const upload = async (name = 'sign.png', image) => {
    image ||= await signatureBitmap();
    const form = new FormData(); form.append('file', new Blob([image], { type: 'image/png' }), name);
    return request('?site_id=1', { method: 'POST', body: form });
  };
  assert.equal((await toggle(true)).status, 400);
  let response = await upload(); assert.equal(response.status, 200);
  let saved = (await response.json()).signature;
  assert.equal(saved.enabled, false); assert.ok(saved.image_data_url);
  response = await toggle(true); assert.equal(response.status, 200);
  assert.equal((await response.json()).signature.enabled, true);
  response = await resize(150); assert.equal(response.status, 200);
  saved = (await response.json()).signature;
  assert.equal(saved.size_percent, 150); assert.equal(saved.enabled, true); assert.ok(saved.image_data_url);
  assert.equal((await (await request()).json()).signature.size_percent, 150, 'size persists on reload');
  for (const value of [49, 201, 125.5, '150', null]) assert.equal((await resize(value)).status, 400);
  assert.equal((await (await request('?site_id=2')).json()).signature.image_data_url, '');
  assert.equal((await (await request('?site_id=2')).json()).signature.size_percent, 100);
  response = await upload('replacement.png'); assert.equal(response.status, 200);
  saved = (await response.json()).signature;
  assert.equal(saved.file_name, 'replacement.png'); assert.equal(saved.enabled, true);
  assert.equal(saved.size_percent, 150, 'replacing the bitmap preserves this site’s chosen size');
  response = await toggle(false);
  saved = (await response.json()).signature;
  assert.equal(saved.enabled, false); assert.ok(saved.image_data_url, 'disabling retains the upload');
  assert.equal(saved.size_percent, 150, 'toggling does not reset size');
  assert.equal((await upload('bad.pdf')).status, 400);
  assert.equal((await upload('large.png', Buffer.alloc(MAX_SIGNATURE_BYTES + 1))).status, 413);
  assert.equal((await request('', { method: 'GET' })).status, 400);
  assert.equal((await request('?site_id=1x')).status, 400);
  assert.equal((await request('?site_id=1', { headers: { 'test-org': '10' } })).status, 404);
  assert.equal((await request('?site_id=1', { method: 'DELETE', headers: { 'test-role': 'sub_admin' } })).status, 403);
  assert.equal((await request('?site_id=2', { headers: { 'test-role': 'sub_admin' } })).status, 403);
  assert.equal((await request('?site_id=1', { headers: { 'test-role': 'sub_admin' } })).status, 200);
  response = await request('?site_id=1', { method: 'DELETE' }); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).signature, { enabled: false, image_data_url: '', file_name: '', size_percent: 100 });
});

test('server PDF receipts use the enabled site signature and preserve recorded customer signatures', async () => {
  const prepared = await prepareReceiptSignature(file(await signatureBitmap()));
  const data = { site_id: 1, site_name: 'Sample site', full_name: 'Sample customer', receipt_no: 'SAMPLE', amount: 500, payment_mode: 'CASH', authority_signature_url: 'https://unavailable.invalid/old.png', customer_signature_url: prepared.image_data_url };
  const design = { site_signature: { ...prepared, enabled: true, site_id: 1, size_percent: 175 } };
  const receipt = configuredPaymentReceipt('PAYMENT_RECEIVED', data, design);
  assert.equal(receipt.siteSignature, prepared.image_data_url);
  assert.equal(receipt.siteSignatureSizePercent, 175);
  const pdf = await renderConfiguredPaymentReceiptPdf(receipt, data);
  assert.equal(pdf.toString('ascii', 0, 5), '%PDF-');
  assert.equal(configuredPaymentReceipt('PAYMENT_RECEIVED', { ...data, site_id: 2 }, design).siteSignature, '');
  assert.equal(configuredPaymentReceipt('PAYMENT_RECEIVED', data, { site_signature: { ...design.site_signature, enabled: false } }).siteSignature, '');
});
