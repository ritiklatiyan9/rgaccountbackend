// Narrow local preview: the actual Seek Permission auth/router/socket code,
// without accounting migrations, background workers, or unrelated API routes.
import 'dotenv/config';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import pool from '../src/config/db.js';
import { createSeekPermissionRouter } from '../src/routes/seekPermission.routes.js';
import { createSeekPermissionPreviewAuth } from '../src/middlewares/seekPermissionPreviewAuth.middleware.js';
import errorMiddleware from '../src/middlewares/error.middleware.js';
import { initSocket } from '../src/config/socket.js';
import { up as migrateSeekComments } from '../src/migrations/230_seek_permission_comments.js';
import { up as migrateSeekPriority } from '../src/migrations/231_seek_permission_priority.js';

export const SEEK_PREVIEW_ORIGINS = Object.freeze(['http://127.0.0.1:5174', 'http://localhost:5174']);
export const isSeekPreviewOrigin = origin => !origin || SEEK_PREVIEW_ORIGINS.includes(origin);

const previewCors = {
  origin(origin, callback) {
    if (isSeekPreviewOrigin(origin)) return callback(null, true);
    callback(Object.assign(new Error('This local preview only accepts the dashboard on localhost:5174.'), { statusCode: 403 }));
  },
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-ID', 'X-App-Context'],
};

export function createSeekPermissionPreviewApp({ authBridge = createSeekPermissionPreviewAuth({ database: pool }), authenticate = authBridge.authenticate } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors(previewCors));
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, service: 'seek-permission-preview' }));
  // Hosted session proof is bridged only here; production keeps its normal JWT
  // verifier. Current local session/account and service visibility still apply.
  app.use('/seek-permissions', createSeekPermissionRouter({ authenticate }));
  app.use((_req, res) => res.status(404).json({ message: 'This preview only serves Seek Permission.' }));
  app.use(errorMiddleware);
  return app;
}

export function createSeekPermissionPreviewServer({ socketInitializer = initSocket,
  authBridge = createSeekPermissionPreviewAuth({ database: pool }) } = {}) {
  const app = createSeekPermissionPreviewApp({ authBridge });
  const server = http.createServer(app);
  const io = socketInitializer(server, {
    cors: { origin: previewCors.origin, methods: ['GET', 'POST'] },
    authenticate: authBridge.authenticateSocket,
    authorizeUserDelivery: authBridge.authorizeUserDelivery,
    // Websocket upgrades do not rely on browser CORS preflights.
    allowRequest: (request, callback) => callback(null, isSeekPreviewOrigin(request.headers.origin)),
  });
  return { app, server, io };
}

export async function assertSeekPreviewBaseSchema(database = pool) {
  const { rows: [schema] } = await database.query(`SELECT
    to_regclass('seek_permissions') IS NOT NULL AS requests,
    to_regclass('seek_permission_access') IS NOT NULL AS access,
    to_regclass('app_schema_migrations') IS NOT NULL AS registry,
    ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = to_regclass('seek_permissions')
      AND attnum > 0 AND NOT attisdropped) AS request_columns,
    ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = to_regclass('seek_permission_access')
      AND attnum > 0 AND NOT attisdropped) AS access_columns`);
  const missing = ['requests', 'access', 'registry'].filter(key => !schema?.[key]);
  for (const column of ['id', 'site_id', 'requested_by', 'title', 'amount', 'party_name', 'reason', 'status',
    'decided_by', 'decided_at', 'decision_note', 'requester_seen_at', 'created_at', 'updated_at', 'asked_to', 'attachments']) {
    if (!schema?.request_columns?.includes(column)) missing.push(`seek_permissions.${column}`);
  }
  for (const column of ['site_id', 'user_id', 'scope', 'visible_user_ids', 'updated_by', 'updated_at']) {
    if (!schema?.access_columns?.includes(column)) missing.push(`seek_permission_access.${column}`);
  }
  if (missing.length) {
    throw Object.assign(new Error(`Seek Permission preview cannot start: base migrations 222/223 are required (${missing.join(', ')} missing). Only comment and priority metadata migrations are applied by this command.`),
      { code: 'SEEK_PREVIEW_BASE_SCHEMA_MISSING' });
  }
  return schema;
}

export function seekPreviewPort(value = process.env.SEEK_PERMISSION_PREVIEW_PORT || 8006) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error('SEEK_PERMISSION_PREVIEW_PORT must be between 1 and 65535');
  return Number(value);
}

const migrateSeekFeatures = async database => { await migrateSeekComments(database); await migrateSeekPriority(database); };

export async function startSeekPermissionPreview({ database = pool, port = seekPreviewPort(), migrate = migrateSeekFeatures,
  socketInitializer = initSocket } = {}) {
  const listenPort = seekPreviewPort(port);
  await assertSeekPreviewBaseSchema(database);
  // Only this module's comment and priority metadata; no financial migrations.
  await migrate(database);
  const preview = createSeekPermissionPreviewServer({ socketInitializer });
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { preview.server.off('listening', ready); reject(error); };
      const ready = () => { preview.server.off('error', failed); resolve(); };
      preview.server.once('error', failed);
      preview.server.once('listening', ready);
      preview.server.listen(listenPort, '127.0.0.1');
    });
  } catch (error) {
    await new Promise(resolve => preview.io.close(resolve));
    throw error;
  }
  return { ...preview, port: listenPort, url: `http://127.0.0.1:${listenPort}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startSeekPermissionPreview().then(preview => {
    console.log(`Seek Permission preview ready on ${preview.url}`);
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.once(signal, () => {
        preview.io.close(() => pool.end().finally(() => process.exit(0)));
        setTimeout(() => process.exit(0), 5000).unref();
      });
    }
  }).catch(async error => {
    console.error('Seek Permission preview failed:', error.message);
    await pool.end();
    process.exitCode = 1;
  });
}
