import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('voucher uploader sends the complete photo even when 100-continue is delayed', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voucher-s3-'));
  const bytes = Buffer.alloc(215925, 42);
  const photo = path.join(directory, 'photo.jpeg');
  await writeFile(photo, bytes);
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = { bytes: Buffer.concat(chunks), url: req.url, type: req.headers['content-type'] };
    res.writeHead(200, { ETag: '"local-photo"' });
    res.end();
  });
  // Reproduce a remote endpoint whose initial response arrives after the SDK's
  // one-second continue wait. The old SDK path would never send the body.
  server.on('checkContinue', (req, res) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeContinue();
      server.emit('request', req, res);
    }, 1200);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = {
    AWS_ACCESS_KEY_ID: 'local-test-key', AWS_SECRET_ACCESS_KEY: 'local-test-secret',
    AWS_REGION: 'us-east-1', AWS_S3_BUCKET_NAME: 'test-storage',
    AWS_ENDPOINT_URL_S3: `http://127.0.0.1:${server.address().port}`,
  };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const { uploadToS3 } = await import('../src/utils/aws.js');
    const url = await uploadToS3(photo, 'photo.jpeg', 'image/jpeg', 'vouchers');
    assert.deepEqual(received.bytes, bytes);
    assert.match(received.url, /^\/test-storage\/vouchers\/\d+-photo\.jpeg/);
    assert.equal(received.type, 'image/jpeg');
    assert.match(url, /^https:\/\/test-storage\.s3\.us-east-1\.amazonaws\.com\/vouchers\//);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
