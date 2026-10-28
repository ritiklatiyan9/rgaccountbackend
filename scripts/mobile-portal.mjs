// Isolated, read-only local API for the Flutter phone preview. Starting this
// server never imports staff routes, runs migrations, or schedules background jobs.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import mobilePortalRoutes from '../src/routes/mobilePortal.routes.js';
import pool from '../src/config/db.js';

// A local preview gets an in-memory random key when no dedicated key exists.
// Restarting the preview revokes its sessions without changing staff secrets.
if (!process.env.MOBILE_PORTAL_SECRET) process.env.MOBILE_PORTAL_SECRET = randomBytes(32).toString('hex');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '2kb' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'my-real-assets' }));
app.use('/api/mobile', mobilePortalRoutes);
app.use((_req, res) => res.status(404).json({ message: 'Unavailable.' }));
app.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400)
  .json({ message: 'The request could not be processed.' }));

const server = http.createServer(app);
const port = Number(process.env.MOBILE_PORTAL_PORT || 8090);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set a valid MOBILE_PORTAL_PORT.');
try {
  await pool.query('SELECT 1');
  server.listen(port, '127.0.0.1', () => console.log(`My Real Assets local API ready at http://127.0.0.1:${port}`));
} catch {
  console.error('My Real Assets API could not connect to the configured Accounts database.');
  await pool.end();
  process.exitCode = 1;
}
server.on('error', () => {
  console.error('My Real Assets local API could not listen on the configured port.');
  void pool.end().finally(() => { process.exitCode = 1; });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
});
