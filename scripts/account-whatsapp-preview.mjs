// Narrow local Studio API. Starts no accounting automations or financial schedulers.
import 'dotenv/config';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';

const ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

export function loadSharedWhatsAppSender(file, environment = process.env) {
  if (!file) return false;
  const source = dotenv.parse(fs.readFileSync(file));
  let copied = false;
  for (const key of Object.keys(source)) {
    if (!/^WHATSAPP_[A-Z0-9_]+$/.test(key) || environment[key] !== undefined) continue;
    environment[key] = source[key];
    copied = true;
  }
  // Some installations use the default AWS chain for the shared sender.
  for (const key of ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN', 'REGION']) {
    const target = `WHATSAPP_AWS_${key}`;
    if (environment[target] === undefined && source[`AWS_${key}`]) environment[target] = source[`AWS_${key}`];
  }
  return copied;
}

export function createAccountWhatsAppPreviewApp({ campaignRouter, inboxRouter, errorHandler } = {}) {
  if (!campaignRouter || !inboxRouter) throw new Error('Authenticated campaign and inbox routers are required.');
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) {
      callback(!origin || ORIGINS.has(origin) ? null : Object.assign(new Error('This preview accepts the local Accounts dashboard only.'), { statusCode: 403 }), true);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-ID', 'X-App-Context'],
    exposedHeaders: ['Content-Disposition'],
  }));
  app.use(express.json({ limit: '128kb' }));
  app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ service: 'account-whatsapp-preview', version: 1 }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/account-whatsapp/campaigns', campaignRouter);
  app.use('/account-whatsapp/inbox', inboxRouter);
  app.use((_req, res) => res.status(404).json({ message: 'This preview serves WhatsApp campaigns and the customer inbox.' }));
  if (errorHandler) app.use(errorHandler);
  return app;
}

export async function startAccountWhatsAppPreview() {
  dotenv.config({ path: '.env.whatsapp.local', quiet: true });
  loadSharedWhatsAppSender(process.env.ACCOUNT_WHATSAPP_SHARED_SENDER_ENV);
  const port = Number(process.env.ACCOUNT_WHATSAPP_PREVIEW_PORT || 8014);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a valid WhatsApp preview port.');
  const [{ default: pool }, { createSeekPermissionPreviewAuth }, { createAccountWhatsAppCampaignsRouter },
    { createAccountWhatsAppInboxRouter }, { default: errorHandler }] = await Promise.all([
    import('../src/config/db.js'),
    import('../src/middlewares/seekPermissionPreviewAuth.middleware.js'),
    import('../src/routes/accountWhatsAppCampaigns.routes.js'),
    import('../src/routes/accountWhatsAppInbox.routes.js'),
    import('../src/middlewares/error.middleware.js'),
  ]);
  const { authenticate } = createSeekPermissionPreviewAuth({ database: pool });
  const app = createAccountWhatsAppPreviewApp({
    campaignRouter: createAccountWhatsAppCampaignsRouter({ authenticate }),
    inboxRouter: createAccountWhatsAppInboxRouter({ authenticate }),
    errorHandler,
  });
  const server = app.listen(port, '127.0.0.1', () => console.log(`WhatsApp campaigns and inbox ready on http://127.0.0.1:${port}`));
  let worker, inbound;
  if (process.env.ACCOUNT_WHATSAPP_CAMPAIGN_WORKER === 'true') {
    worker = await import('../src/workers/accountWhatsAppCampaignWorker.js');
    worker.startAccountWhatsAppCampaignWorker();
  }
  if (process.env.WHATSAPP_INBOX_QUEUE_URL) {
    inbound = await import('../src/workers/accountWhatsAppInboundWorker.js');
    inbound.startAccountWhatsAppInboundWorker();
  }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    worker?.stopAccountWhatsAppCampaignWorker();
    inbound?.stopAccountWhatsAppInboundWorker();
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { app, server, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAccountWhatsAppPreview().catch(error => { console.error('WhatsApp preview failed:', error.code || error.message); process.exitCode = 1; });
}
