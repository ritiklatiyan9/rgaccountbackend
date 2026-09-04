import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = {
  DMS_OCR_ENGINE: process.env.DMS_OCR_ENGINE,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_VISION_MODEL: process.env.OPENROUTER_VISION_MODEL,
  OPENROUTER_PDF_ENGINE: process.env.OPENROUTER_PDF_ENGINE,
};

process.env.DMS_OCR_ENGINE = 'openrouter';
process.env.OPENROUTER_API_KEY = 'test-key';
process.env.OPENROUTER_VISION_MODEL = 'test/vision-model';
process.env.OPENROUTER_PDF_ENGINE = 'mistral-ocr';

const { runDmsOcr } = await import(`../src/services/dmsOcr.service.js?test=${Date.now()}`);

test.after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('routes PDF OCR through OpenRouter with the configured paid PDF parser', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'PDF OCR text' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await runDmsOcr(Buffer.from('%PDF-test'), 'application/pdf');

  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'test/vision-model');
  assert.deepEqual(request.body.plugins, [{
    id: 'file-parser',
    pdf: { engine: 'mistral-ocr' },
  }]);
  const filePart = request.body.messages[0].content[1];
  assert.equal(filePart.type, 'file');
  assert.equal(filePart.file.filename, 'kyc-document.pdf');
  assert.match(filePart.file.file_data, /^data:application\/pdf;base64,/);
  assert.equal(result.text, 'PDF OCR text');
  assert.match(result.engine, /^or-vision:/);
});

test('keeps image OCR on OpenRouter without the PDF parser plugin', async () => {
  let body;
  globalThis.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Image OCR text' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await runDmsOcr(Buffer.from('image-test'), 'image/jpeg');

  assert.equal(body.plugins, undefined);
  assert.equal(body.messages[0].content[1].type, 'image_url');
  assert.match(body.messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(result.text, 'Image OCR text');
});
