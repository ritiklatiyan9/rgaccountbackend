import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sanitizeAuditValue } from '../src/services/auditLog.service.js';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('audit payloads redact credentials and omit large binary values', () => {
  const sanitized = sanitizeAuditValue({
    email: 'user@example.com',
    password: 'never-store-me',
    nested: { refresh_token: 'never-store-this-either' },
    photo: `data:image/png;base64,${'a'.repeat(3000)}`,
  });

  assert.equal(sanitized.email, 'user@example.com');
  assert.equal(sanitized.password, '[redacted]');
  assert.equal(sanitized.nested.refresh_token, '[redacted]');
  assert.equal(sanitized.photo, '[binary omitted]');
});

test('audit storage is indexed, append-only, and defaults to 100 rows', async () => {
  const migration = await readSource('src/migrations/103_audit_logs.js');
  const controller = await readSource('src/controllers/auditLog.controller.js');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS audit_logs/);
  assert.match(migration, /transaction_name TEXT/);
  assert.match(migration, /amount NUMERIC\(18,2\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE ON audit_logs/);
  assert.match(migration, /idx_audit_logs_org_created/);
  assert.match(migration, /idx_audit_logs_user_created/);
  assert.match(controller, /Math\.min\(100, positiveInt\(req\.query\.limit, 100\)\)/);
});

test('audit access is permission-gated and new sub-admin access fails closed', async () => {
  const routes = await readSource('src/routes/auditLog.routes.js');
  const permissions = await readSource('src/models/Permission.model.js');

  assert.match(routes, /authMiddleware, requirePermission\('audit_logs', 'read'\)/);
  assert.match(permissions, /RESTRICTED_MODULES[\s\S]*'audit_logs'/);
  assert.match(permissions, /'audit_logs'/);
});

test('central middleware records mutation failures after authentication', async () => {
  const middleware = await readSource('src/middlewares/audit.middleware.js');

  assert.match(middleware, /POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE'/);
  assert.match(middleware, /res\.once\('finish'/);
  assert.match(middleware, /if \(!actor\?\.id\) return/);
  assert.match(middleware, /res\.statusCode >= 200 && res\.statusCode < 400 \? 'SUCCESS' : 'FAILURE'/);
});
