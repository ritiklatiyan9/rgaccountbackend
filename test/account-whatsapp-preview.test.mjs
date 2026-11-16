import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAccountWhatsAppPreviewApp, loadSharedWhatsAppSender } from '../scripts/account-whatsapp-preview.mjs';

test('shared sender configuration never imports database credentials or replaces explicit sender settings', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'account-whatsapp-config-'));
  try {
    const file = path.join(directory, 'sender.env');
    fs.writeFileSync(file, 'WHATSAPP_ENABLED=true\nWHATSAPP_PHONE_NUMBER_ID=shared-phone\nWHATSAPP_AWS_ACCESS_KEY_ID=dedicated-key\nAWS_SECRET_ACCESS_KEY=fallback-secret\nDB_PASSWORD=never-import\nJWT_SECRET=never-import\n');
    const environment = { WHATSAPP_ENABLED: 'false', WHATSAPP_PHONE_NUMBER_ID: 'explicit-phone' };
    assert.equal(loadSharedWhatsAppSender(file, environment), true);
    assert.equal(environment.WHATSAPP_ENABLED, 'false');
    assert.equal(environment.WHATSAPP_PHONE_NUMBER_ID, 'explicit-phone');
    assert.equal(environment.WHATSAPP_AWS_ACCESS_KEY_ID, 'dedicated-key');
    assert.equal(environment.WHATSAPP_AWS_SECRET_ACCESS_KEY, 'fallback-secret');
    assert.equal(environment.DB_PASSWORD, undefined);
    assert.equal(environment.JWT_SECRET, undefined);
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('preview exposes narrow authenticated APIs and refuses a foreign browser origin', async () => {
  let mutations = 0;
  const protectedRouter = express.Router();
  protectedRouter.use((req, res, next) => req.get('Authorization') === 'Bearer valid-session' ? next() : res.status(401).json({ message: 'Sign in' }));
  protectedRouter.get('/', (_req, res) => res.json({ items: [] }));
  protectedRouter.post('/', (_req, res) => { mutations++; res.status(201).json({}); });
  const app = createAccountWhatsAppPreviewApp({
    campaignRouter: protectedRouter,
    inboxRouter: protectedRouter,
    errorHandler: (error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${origin}/health`);
    assert.equal((await health.json()).service, 'account-whatsapp-preview');
    assert.equal((await fetch(`${origin}/account-whatsapp/campaigns`)).status, 401);
    assert.equal((await fetch(`${origin}/account-whatsapp/inbox`, { headers: { Authorization: 'Bearer valid-session', Origin: 'https://unrelated.example' } })).status, 403);
    const response = await fetch(`${origin}/account-whatsapp/inbox`, { headers: { Authorization: 'Bearer valid-session', Origin: 'http://localhost:5173' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { items: [] });
    assert.equal((await fetch(`${origin}/daybook`, { headers: { Authorization: 'Bearer valid-session' } })).status, 404);
    assert.equal(mutations, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
