import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';

// Pure-logic checks: no DB, no Google. The key must exist before the modules
// load because the state HMAC and token crypto read it at call time.
process.env.CALENDAR_TOKEN_ENC_KEY = 'a'.repeat(64);

const { signOAuthState, verifyOAuthState } = await import('../src/utils/googleOAuthState.js');
const {
  istDateFolder, escapeDriveQuery, translateDriveError, upsertFile, folderPathKey,
} = await import('../src/services/googleDrive.service.js');

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('OAuth state round-trips kind, rejects tampering and expiry', () => {
  const state = signOAuthState({ orgId: 1, userId: 7, origin: 'https://app.test', kind: 'drive' });
  assert.deepEqual(verifyOAuthState(state), { orgId: 1, userId: 7, origin: 'https://app.test', kind: 'drive' });
  assert.equal(verifyOAuthState(signOAuthState({ orgId: 1, userId: 7, origin: 'x' })).kind, 'calendar');

  const [payload, sig] = state.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), o: 2 })).toString('base64url');
  assert.equal(verifyOAuthState(`${tampered}.${sig}`), null);
  assert.equal(verifyOAuthState('garbage'), null);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60 * 1000;
    assert.equal(verifyOAuthState(state), null);
  } finally {
    Date.now = realNow;
  }
});

test('istDateFolder uses the IST calendar day', () => {
  assert.equal(istDateFolder(new Date('2026-10-03T20:30:00Z')), '04-10-2026');
  assert.equal(istDateFolder(new Date('2026-10-03T06:00:00Z')), '03-10-2026');
  assert.equal(folderPathKey(['03-10-2026', 'Project Commission', 'Agent X - Plot A1']), '03-10-2026/Project Commission/Agent X - Plot A1');
});

test('escapeDriveQuery escapes backslashes before quotes', () => {
  assert.equal(escapeDriveQuery("O'Neil \\ x"), "O\\'Neil \\\\ x");
});

test('translateDriveError maps Google and pg failures', () => {
  const pick = (e) => { const t = translateDriveError(e); return [t.statusCode, t.code]; };
  assert.deepEqual(pick({ response: { data: { error: 'invalid_grant' } } }), [409, 'GOOGLE_DRIVE_REAUTH']);
  assert.deepEqual(pick(new Error('invalid_grant: Token has been expired')), [409, 'GOOGLE_DRIVE_REAUTH']);
  assert.deepEqual(pick({ code: 403, errors: [{ reason: 'accessNotConfigured' }] }), [503, 'GOOGLE_DRIVE_API_DISABLED']);
  assert.deepEqual(pick({ response: { data: { error: { errors: [{ reason: 'invalidSharingRequest' }] } } } }), [400, 'NOT_A_GOOGLE_ACCOUNT']);
  assert.deepEqual(pick({ code: '42P01' }), [503, 'GOOGLE_DRIVE_NOT_READY']);
  assert.deepEqual(pick({ status: 404, response: { status: 404 } }), [404, 'GOOGLE_DRIVE_NOT_FOUND']);
  assert.deepEqual(pick(new Error('boom')), [502, 'GOOGLE_DRIVE_FAILED']);
  assert.match(translateDriveError({ code: '42P01' }).message, /database update is required/);
});

const stubDrive = (existing = []) => {
  const calls = { create: [], update: [] };
  const file = { id: 'f1', name: 'Doc', webViewLink: 'https://docs.google.com/d/f1', mimeType: 'application/vnd.google-apps.document' };
  return {
    calls,
    drive: {
      files: {
        list: async () => ({ data: { files: existing } }),
        create: async (args) => { calls.create.push(args); return { data: file }; },
        update: async (args) => { calls.update.push(args); return { data: file }; },
      },
    },
  };
};

test('upsertFile streams Buffers and sends conversion mime on create', async () => {
  const { drive, calls } = stubDrive();
  const result = await upsertFile({ drive }, {
    parentId: 'p1', name: 'Doc', mimeType: 'text/html', body: Buffer.from('<p>hi</p>'),
    convertTo: 'application/vnd.google-apps.document',
  });
  assert.equal(calls.create.length, 1);
  const [args] = calls.create;
  assert.ok(args.media.body instanceof Readable, 'media body must be a Readable, never a Buffer');
  assert.deepEqual(args.requestBody, { name: 'Doc', parents: ['p1'], mimeType: 'application/vnd.google-apps.document' });
  assert.deepEqual(result, { id: 'f1', name: 'Doc', url: 'https://docs.google.com/d/f1', mime_type: 'application/vnd.google-apps.document', created: true });
});

test('upsertFile updates an existing file without parents or mime conversion', async () => {
  const { drive, calls } = stubDrive([{ id: 'f1', name: 'Doc' }]);
  const result = await upsertFile({ drive }, { parentId: 'p1', name: 'Doc', mimeType: 'text/html', body: 'x' });
  // Callers rely on this to leave Docs created by earlier shares alone.
  assert.equal(result.created, false);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 1);
  const [args] = calls.update;
  assert.equal(args.fileId, 'f1');
  assert.equal(args.requestBody, undefined);
  assert.ok(args.media.body instanceof Readable);
});

test('migration creates the four tables and three indexes', async () => {
  const migration = await read('../src/migrations/188_google_drive_sharing.js');
  for (const table of ['google_drive_connections', 'google_drive_access_emails', 'google_drive_folders', 'google_drive_shares']) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  for (const idx of ['idx_gdrive_shares_entity', 'idx_gdrive_shares_recent', 'idx_gdrive_shares_site']) {
    assert.match(migration, new RegExp(`CREATE INDEX IF NOT EXISTS ${idx}`));
  }
  assert.match(migration, /188_google_drive_sharing/);
});

test('drive settings routes are authenticated and writes are admin-only', async () => {
  const routes = await read('../src/routes/googleDrive.routes.js');
  assert.match(routes, /router\.get\('\/google-drive\/status', authMiddleware, attachOrgContext, getStatus\)/);
  for (const line of [
    "router.get('/google-drive/connect', authMiddleware, attachOrgContext, requireRole('admin')",
    "router.post('/google-drive/disconnect', authMiddleware, attachOrgContext, requireRole('admin')",
    "router.get('/google-drive/emails', authMiddleware, attachOrgContext, requireRole('admin')",
    "router.post('/google-drive/emails', authMiddleware, attachOrgContext, requireRole('admin')",
    "router.patch('/google-drive/emails/:id', authMiddleware, attachOrgContext, requireRole('admin')",
    "router.delete('/google-drive/emails/:id', authMiddleware, attachOrgContext, requireRole('admin')",
    "router.get('/google-drive/shares', authMiddleware, attachOrgContext, requireRole('admin')",
  ]) {
    assert.ok(routes.includes(line), `missing: ${line}`);
  }
});

test('calendar callback dispatches drive states and guards token revocation', async () => {
  const calendar = await read('../src/controllers/googleCalendar.controller.js');
  assert.match(calendar, /state\?\.kind === 'drive'\) return handleDriveOAuthCallback\(req, res, state\)/);
  assert.match(calendar, /FROM google_drive_connections[\s\S]*status='active' AND google_account_email=\$2/);
  const drive = await read('../src/controllers/googleDrive.controller.js');
  assert.match(drive, /FROM google_calendar_connections[\s\S]*status='active' AND google_account_email=\$2/);
  assert.doesNotMatch(drive, /googleCalendar\.controller/);
});
