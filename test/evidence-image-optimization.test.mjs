import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import optimizeEvidenceImages, { optimizeEvidenceImage } from '../src/middlewares/optimizeEvidenceImages.middleware.js';
import { receiveUpload } from '../src/middlewares/multer.middleware.js';

async function photo() {
  const width = 2600, height = 1600;
  const bytes = Buffer.alloc(width * height * 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + (i >> 8) * 37) % 256;
  return sharp(bytes, { raw: { width, height, channels: 3 } }).jpeg({ quality: 98 }).toBuffer();
}

test('evidence images are reduced before controllers consume their buffer and metadata', async () => {
  const buffer = await photo();
  const file = { originalname: 'bill.jpg', mimetype: 'image/jpeg', size: buffer.length, buffer };
  await optimizeEvidenceImage(file);
  const metadata = await sharp(file.buffer).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 2400);
  assert.equal(file.size, file.buffer.length);
  assert.ok(file.size < buffer.length);
});

test('disk uploads retain name and MIME, update size, and write usable compact bytes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evidence-optimize-'));
  try {
    const buffer = await photo();
    const file = { originalname: 'voucher.jpg', mimetype: 'image/jpeg', path: path.join(dir, 'upload.jpg'), size: buffer.length };
    await writeFile(file.path, buffer);
    await new Promise((resolve, reject) => optimizeEvidenceImages({ files: [file] }, {}, error => error ? reject(error) : resolve()));
    const saved = await readFile(file.path);
    assert.equal(saved.length, file.size);
    assert.ok(saved.length < buffer.length);
    assert.equal((await sharp(saved).metadata()).width, 2400);
    assert.equal(file.mimetype, 'image/jpeg');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('compact images, PDFs and signature images remain byte-exact', async () => {
  const image = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const compactJpeg = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: '#6688aa' } }).jpeg({ quality: 85 }).toBuffer();
  const alreadyOptimized = { originalname: 'photo.jpg', buffer: compactJpeg, size: compactJpeg.length };
  await optimizeEvidenceImage(alreadyOptimized);
  assert.strictEqual(alreadyOptimized.buffer, compactJpeg);
  const signature = await sharp({ create: { width: 2601, height: 500, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const signatureFile = { originalname: 'customer-signature.png', size: signature.length, buffer: signature };
  await optimizeEvidenceImage(signatureFile);
  assert.strictEqual(signatureFile.buffer, signature);
  for (const name of ['image.png', 'receipt.pdf']) {
    const file = { originalname: name, size: image.length, buffer: image };
    await optimizeEvidenceImage(file);
    assert.strictEqual(file.buffer, image);
    assert.equal(file.size, image.length);
  }
});


test('routes can preserve exact bytes for non-AWS providers', async () => {
  const buffer = await photo();
  const file = { originalname: 'chat.jpg', mimetype: 'image/jpeg', size: buffer.length, buffer };
  const parser = (_req, _res, callback) => callback();
  await new Promise((resolve, reject) => receiveUpload(parser, { shouldOptimize: () => false })({ file }, {}, error => error ? reject(error) : resolve()));
  assert.strictEqual(file.buffer, buffer);
  assert.equal(file.size, buffer.length);
});
