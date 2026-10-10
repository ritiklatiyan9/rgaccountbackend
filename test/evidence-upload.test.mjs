import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import upload, { receiveUpload } from '../src/middlewares/multer.middleware.js';
import receiveProof from '../src/middlewares/proofUpload.middleware.js';

test('dedicated modules and quick uploads accept PDF/photo multipart files consistently', async t => {
  const previousCwd = process.cwd();
  const directory = await mkdtemp(path.join(tmpdir(), 'accounts-evidence-'));
  process.chdir(directory);
  const app = express();
  const reply = async (req, res) => {
    const files = req.files || (req.file ? [req.file] : []);
    res.json({ body: req.body, files: await Promise.all(files.map(async file => ({
      name: file.originalname, mime: file.mimetype, savedName: file.filename,
      bytes: (file.buffer || await readFile(file.path)).toString(),
    }))) });
  };
  app.post('/single', receiveUpload(upload.single('file')), reply);
  app.post('/many', receiveUpload(upload.array('files')), reply);
  app.post('/edit-proof', receiveUpload(upload.single('proof_photo')), reply);
  for (const endpoint of ['/imprest/expense', '/imprest/allocations', '/imprest/adjust', '/imprest/returns', '/document-imprest', '/document-imprest/return', '/document-imprest/outcome']) {
    app.post(endpoint, receiveProof, reply);
  }
  const server = app.listen(0, '127.0.0.1');
  let base;
  const request = (endpoint, field, name, mime, bytes = 'fixture') => {
    const body = new FormData();
    body.set('site_id', '5');
    body.append(field, new Blob([bytes], { type: mime }), name);
    return fetch(`${base}${endpoint}`, { method: 'POST', body });
  };
  try {
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    base = `http://127.0.0.1:${server.address().port}`;
    await t.test('PDFs and all supported photos work with generic and missing MIME metadata', async () => {
      for (const [endpoint, field] of [['/single', 'file'], ['/edit-proof', 'proof_photo'], ['/imprest/expense', 'photo'], ['/imprest/allocations', 'photo'], ['/imprest/adjust', 'photo'], ['/imprest/returns', 'photo'], ['/document-imprest', 'photo'], ['/document-imprest/return', 'photo'], ['/document-imprest/outcome', 'photo']]) {
        for (const [name, mime, expected] of [['scan.PDF', '', 'application/pdf'], ['receipt.pdf', 'application/pdf', 'application/pdf'], ['photo.jpg', 'image/jpg', 'image/jpeg'], ['photo.png', 'image/png', 'image/png'], ['photo.webp', 'image/webp', 'image/webp']]) {
          const response = await request(endpoint, field, name, mime);
          assert.equal(response.status, 200, `${endpoint}: ${name}`);
          const result = await response.json();
          assert.equal(result.files[0].mime, expected);
          assert.equal(result.files[0].bytes, 'fixture');
          assert.equal(result.body.site_id, '5');
        }
      }
    });
    await t.test('simultaneous multi-file uploads keep each attachment and its contents', async () => {
      const body = new FormData();
      for (const bytes of ['first', 'second', 'third']) body.append('files', new Blob([bytes], { type: 'application/pdf' }), 'receipt.pdf');
      t.mock.method(Date, 'now', () => 123456789);
      const response = await fetch(`${base}/many`, { method: 'POST', body });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.files.map(file => file.bytes), ['first', 'second', 'third']);
      assert.equal(new Set(result.files.map(file => file.savedName)).size, 3);
      t.mock.restoreAll();
    });
    await t.test('unsupported and oversized uploads report useful client errors', async () => {
      for (const [endpoint, field, limit] of [['/single', 'file', 5], ['/imprest/expense', 'photo', 10]]) {
        for (const [name, mime] of [['file.exe', 'application/pdf'], ['file.pdf', 'image/png']]) {
          const response = await request(endpoint, field, name, mime);
          assert.equal(response.status, 400);
          assert.ok((await response.json()).message);
        }
        const empty = await request(endpoint, field, 'empty.pdf', 'application/pdf', '');
        assert.equal(empty.status, 400);
        assert.match((await empty.json()).message, /empty/);
        const response = await request(endpoint, field, 'large.pdf', 'application/pdf', new Uint8Array(limit * 1024 * 1024 + 1));
        assert.equal(response.status, 413);
        assert.match((await response.json()).message, new RegExp(`${limit} MB`));
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
