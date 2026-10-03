import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';

// Pure-logic checks: no DB, no Google. The key must exist before the modules
// load because the state HMAC and token crypto read it at call time.
process.env.CALENDAR_TOKEN_ENC_KEY = 'a'.repeat(64);

const { signOAuthState, verifyOAuthState } = await import('../src/utils/googleOAuthState.js');
const {
  istDateFolder, escapeDriveQuery, translateDriveError, upsertFile, folderPathKey, siteFolderName,
  ensureSiteFolder, ensureFolderPath, ensureSubfolders,
  withOrgFolderLock, tryPlotShareLock,
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
  assert.deepEqual(pick({ code: '42703' }), [503, 'GOOGLE_DRIVE_NOT_READY']);
  assert.deepEqual(pick({ code: 'GOOGLE_DRIVE_BUSY' }), [409, 'GOOGLE_DRIVE_BUSY']);
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

test('site folder names come from the site, never create extra levels, and cache keys nest under the site', () => {
  assert.equal(siteFolderName({ id: 10, name: 'SHRI GANESH ASSOCIATES' }), 'SHRI GANESH ASSOCIATES');
  assert.equal(siteFolderName({ id: 1, name: 'Phase 1/2' }), 'Phase 1_2');
  assert.equal(siteFolderName({ id: 7, name: '' }), 'Site 7');
  assert.equal(folderPathKey(['site:10', '03-10-2026', 'Project Commission']), 'site:10/03-10-2026/Project Commission');
  assert.equal(folderPathKey(['', '03-10-2026']), '03-10-2026');
});

test('uploads report consumed payload bytes for creates and updates before Drive confirms completion', async () => {
  for (const existing of [null, { id: 'f1' }]) {
    const body = Buffer.alloc(150_000, 42);
    const events = [];
    let consumed = false;
    let confirm;
    const confirmed = new Promise((resolve) => { confirm = resolve; });
    const upload = async ({ media }) => {
      assert.equal(events.length, 0, 'progress must wait for transport consumption');
      const chunks = [];
      for await (const chunk of media.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), body);
      consumed = true;
      await confirmed;
      return { data: { id: 'f1', name: 'Sheet.xlsx' } };
    };
    let complete = false;
    const pending = upsertFile({ drive: { files: { create: upload, update: upload } } }, {
      parentId: 'p1', name: 'Sheet.xlsx', mimeType: 'application/octet-stream', body, existing,
      onUploadProgress: (event) => events.push(event),
    }).then((value) => { complete = true; return value; });
    while (!consumed) await new Promise(setImmediate);
    assert.equal(complete, false, 'all bytes read does not mean Drive saved the file');
    assert.deepEqual(events.map((event) => event.bytes_sent), [65_536, 131_072, 150_000]);
    assert.ok(events.every((event) => event.bytes_total === body.length));
    confirm();
    assert.equal((await pending).created, !existing);
  }
});

test('resumable upload uses a counted stream and the exact content length', async () => {
  const body = Buffer.alloc(5 * 1024 * 1024, 7);
  const events = [];
  const requests = [];
  const ctx = {
    drive: { files: {} },
    auth: { request: async (request) => {
      requests.push(request);
      if (request.method === 'POST') return { headers: new Headers({ location: 'https://upload.test/session' }) };
      assert.equal(request.url, 'https://upload.test/session');
      assert.equal(request.headers['Content-Length'], String(body.length));
      const chunks = [];
      for await (const chunk of request.data) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), body);
      return { data: { id: 'large', name: 'Large.xlsx' } };
    } },
  };
  const result = await upsertFile(ctx, {
    parentId: 'p1', name: 'Large.xlsx', mimeType: 'application/octet-stream', body, existing: null,
    onUploadProgress: (event) => events.push(event),
  });
  assert.equal(result.id, 'large');
  assert.equal(requests.length, 2);
  assert.ok(events.length > 1);
  assert.deepEqual(events.at(-1), { bytes_sent: body.length, bytes_total: body.length });
});

test('a deleted known file is re-resolved by name and its replacement updated with a fresh body', async () => {
  const updates = [];
  const ctx = { drive: { files: {
    list: async () => ({ data: { files: [{ id: 'replacement' }] } }),
    update: async ({ fileId, media }) => {
      const chunks = [];
      for await (const chunk of media.body) chunks.push(chunk);
      updates.push({ fileId, body: Buffer.concat(chunks).toString() });
      if (fileId === 'deleted') throw { response: { status: 404 } };
      return { data: { id: fileId, name: 'Ledger.xlsx' } };
    },
    create: async () => assert.fail('an existing replacement must not be duplicated'),
  } } };
  const result = await upsertFile(ctx, {
    parentId: 'p1', name: 'Ledger.xlsx', mimeType: 'application/octet-stream', body: 'data', existing: { id: 'deleted' },
  });
  assert.deepEqual(updates, [{ fileId: 'deleted', body: 'data' }, { fileId: 'replacement', body: 'data' }]);
  assert.equal(result.created, false);
});

const FOLDER = 'application/vnd.google-apps.folder';
const withFolderHarness = async (run) => {
  const folders = new Map([
    ['root', { id: 'root', name: 'Defence Garden Accounts', parents: ['my-drive'], mimeType: FOLDER }],
    ['site', { id: 'site', name: 'Garden', parents: ['root'], mimeType: FOLDER }],
    ['date', { id: 'date', name: 'Today', parents: ['site'], mimeType: FOLDER }],
    ['module', { id: 'module', name: 'Commission', parents: ['date'], mimeType: FOLDER }],
    ['sheets', { id: 'sheets', name: 'Sheets', parents: ['module'], mimeType: FOLDER }],
  ]);
  const sites = new Map([[1, { id: 11, folder_id: 'site', folder_name: 'Garden', root_folder_id: 'root' }]]);
  const cached = new Map([
    ['site:1/Today', { folder_id: 'date', root_folder_id: 'root' }],
    ['site:1/Today/Commission', { folder_id: 'module', root_folder_id: 'root' }],
    ['site:1/Today/Commission/Sheets', { folder_id: 'sheets', root_folder_id: 'root' }],
  ]);
  const calls = { get: [], create: [], grants: [], released: 0, concurrentCreates: 0, maxConcurrentCreates: 0 };
  let locked = false;
  let inTransaction = false;
  const db = {
    release: () => { calls.released += 1; assert.equal(locked, false); assert.equal(inTransaction, false); },
    query: async (sql, params = []) => {
      if (sql === 'BEGIN') { assert.equal(inTransaction, false); inTransaction = true; return { rows: [] }; }
      assert.equal(inTransaction, true, 'folder queries must stay in a pinned transaction');
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { assert.equal(calls.concurrentCreates, 0); locked = false; inTransaction = false; return { rows: [] }; }
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) { assert.equal(locked, false); locked = true; return { rows: [] }; }
      assert.equal(locked, true, 'all folder DB mutations stay under the org lock');
      if (sql.includes('SELECT id, folder_id, folder_name')) {
        const row = sites.get(params[2]);
        return { rows: row?.root_folder_id === params[1] ? [row] : [] };
      }
      if (sql.includes('SELECT path, folder_id')) return { rows: params[2].flatMap((path) => cached.get(path)?.root_folder_id === params[1] ? [{ path, ...cached.get(path) }] : []) };
      if (sql.includes('SELECT id, email, role')) return { rows: [{ id: 99, email: 'ca@example.test', role: 'reader' }] };
      if (sql.includes('INSERT INTO google_drive_site_folders')) sites.set(params[1], { id: 11, root_folder_id: params[2], folder_id: params[3], folder_name: params[4] });
      else if (sql.includes('INSERT INTO google_drive_folders')) cached.set(params[2], { root_folder_id: params[1], folder_id: params[3] });
      else if (sql.includes('DELETE FROM google_drive_folders')) {
        for (const [path, row] of cached) if (row.root_folder_id === params[1] && (path === params[2] || path.startsWith(`${params[2]}/`))) cached.delete(path);
      } else if (!sql.includes('UPDATE google_drive_connections') && !sql.includes('UPDATE google_drive_access_emails') && !sql.includes('UPDATE google_drive_site_folders')) assert.fail(`Unexpected SQL: ${sql}`);
      return { rows: [] };
    },
  };
  const drive = { files: {
    get: async ({ fileId }) => {
      calls.get.push(fileId);
      const data = folders.get(fileId);
      if (!data) throw { status: 404 };
      return { data };
    },
    list: async ({ q }) => {
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const name = q.match(/name = '([^']+)'/)?.[1];
      return { data: { files: [...folders.values()].filter((file) => !file.trashed && file.parents.includes(parent) && (!name || file.name === name)) } };
    },
    create: async ({ requestBody, media }) => {
      if (requestBody.parents[0] !== 'root' && !folders.has(requestBody.parents[0])) throw { status: 404 };
      if (media) {
        for await (const _chunk of media.body) { /* consume upload */ }
        return { data: { id: 'uploaded', ...requestBody } };
      }
      assert.equal(locked, true);
      calls.concurrentCreates += 1;
      calls.maxConcurrentCreates = Math.max(calls.maxConcurrentCreates, calls.concurrentCreates);
      await new Promise(setImmediate);
      const id = `new-${calls.create.length + 1}`;
      calls.create.push({ id, ...requestBody });
      folders.set(id, { id, ...requestBody });
      calls.concurrentCreates -= 1;
      return { data: { id } };
    },
    update: async ({ fileId }) => ({ data: { id: fileId } }),
  }, permissions: { create: async (args) => { calls.grants.push(args); return { data: { id: 'permission' } }; } } };
  const ctx = { drive, orgId: 7, connection: { id: 3, root_folder_id: 'root' } };
  const connect = pool.connect;
  pool.connect = async () => db;
  try { await run({ ctx, calls, folders, cached, sites }); } finally { pool.connect = connect; }
};

test('healthy repeated shares check the deepest path once per job and never recheck its root', async () => withFolderHarness(async ({ ctx, calls }) => {
  const site = await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  const path = await ensureFolderPath(ctx, ['Today', 'Commission'], { base: site });
  const parent = { id: path, key: 'site:1/Today/Commission' };
  assert.equal((await ensureSubfolders(ctx, parent, ['Sheets'])).get('Sheets'), 'sheets');
  await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  await ensureFolderPath(ctx, ['Today', 'Commission'], { base: site });
  await ensureSubfolders(ctx, parent, ['Sheets']);
  assert.deepEqual(calls.get, ['site', 'module', 'sheets']);
  assert.equal(calls.create.length, 0);
  const nextJob = { ...ctx, connection: { ...ctx.connection } };
  await ensureSiteFolder(nextJob, { id: 1, name: 'Garden' });
  assert.deepEqual(calls.get, ['site', 'module', 'sheets', 'site'], 'validation cannot leak into another job');
}));

test('stale sibling cache is rebuilt and distinct missing siblings are created concurrently', async () => withFolderHarness(async ({ ctx, calls, folders, cached }) => {
  const site = await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  const id = await ensureFolderPath(ctx, ['Today', 'Commission'], { base: site });
  folders.delete('sheets');
  const result = await ensureSubfolders(ctx, { id, key: 'site:1/Today/Commission' }, ['Sheets', 'Docs', 'Docs']);
  assert.notEqual(result.get('Sheets'), 'sheets');
  assert.equal(result.size, 2);
  assert.equal(calls.create.length, 2);
  assert.equal(calls.maxConcurrentCreates, 2);
  assert.equal(cached.get('site:1/Today/Commission/Sheets').folder_id, result.get('Sheets'));
}));

test('a failed sibling create keeps the org lock until the other creates have settled', async () => withFolderHarness(async ({ ctx, calls }) => {
  const site = await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  const id = await ensureFolderPath(ctx, ['Today', 'Commission'], { base: site });
  const create = ctx.drive.files.create;
  ctx.drive.files.create = async (args) => {
    if (args.requestBody.name === 'Broken') throw Object.assign(new Error('Drive busy'), { status: 503 });
    return create(args);
  };
  await assert.rejects(ensureSubfolders(ctx, { id, key: 'site:1/Today/Commission' }, ['Broken', 'Docs', 'Images']), /Drive busy/);
  assert.equal(calls.concurrentCreates, 0);
  assert.equal(calls.create.length, 2, 'successful siblings finish before the failed operation unlocks');
}));

test('a folder removed between preparation and upload is recreated and upload retries in its replacement', async () => withFolderHarness(async ({ ctx, calls, folders }) => {
  const site = await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  const id = await ensureFolderPath(ctx, ['Today', 'Commission'], { base: site });
  const sheets = (await ensureSubfolders(ctx, { id, key: 'site:1/Today/Commission' }, ['Sheets'])).get('Sheets');
  folders.delete(sheets);
  const file = await upsertFile(ctx, { parentId: sheets, name: 'Ledger.xlsx', mimeType: 'application/octet-stream', body: Buffer.from('ledger'), existing: null });
  assert.equal(file.id, 'uploaded');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].name, 'Sheets');
}));

test('a recreated site preserves its CA access grants', async () => withFolderHarness(async ({ ctx, calls, folders }) => {
  folders.delete('site');
  const site = await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  assert.notEqual(site.id, 'site');
  assert.equal(calls.grants.length, 1);
  assert.equal(calls.grants[0].fileId, site.id);
  assert.equal(calls.grants[0].requestBody.emailAddress, 'ca@example.test');
}));

test('a moved site cannot validate its deleted former root', async () => withFolderHarness(async ({ ctx, calls, folders }) => {
  folders.get('site').parents = ['somewhere-else'];
  folders.delete('root');
  const site = await ensureSiteFolder(ctx, { id: 1, name: 'Garden' });
  assert.deepEqual(calls.get, ['site', 'root']);
  assert.notEqual(ctx.connection.root_folder_id, 'root');
  assert.notEqual(site.id, 'site');
  assert.equal(calls.grants[0].fileId, site.id);
}));

// Transaction-pooler model: every unpinned query can use a different backend;
// BEGIN pins the backend until COMMIT/ROLLBACK. No real DB connections.
const withLockHarness = async ({ available = true, failures = new Map() }, run) => {
  const calls = [];
  const released = [];
  let nextBackend = 0;
  let pinnedBackend;
  const client = {
    query: async (sql, params) => {
      const backend = pinnedBackend ?? ++nextBackend;
      calls.push({ sql, params, backend });
      if (failures.has(sql)) throw failures.get(sql);
      if (sql === 'BEGIN') pinnedBackend = backend;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') pinnedBackend = undefined;
      return { rows: [{ ok: available }] };
    },
    release: (err) => { released.push(err); },
  };
  const connect = pool.connect;
  pool.connect = async () => client;
  try { await run({ client, calls, released }); } finally { pool.connect = connect; }
};

test('folder lock pins one backend through callback writes and releases at COMMIT', async () => withLockHarness({}, async ({ client, calls, released }) => {
  const result = await withOrgFolderLock(41, async (db) => {
    assert.equal(db, client);
    assert.equal(released.length, 0);
    await db.query('SELECT folder_registry_work');
    return 'ready';
  });
  assert.equal(result, 'ready');
  assert.deepEqual(calls.map(({ sql }) => sql), [
    'BEGIN', "SET LOCAL lock_timeout = '10s'", 'SELECT pg_advisory_xact_lock(hashtext($1))', 'SELECT folder_registry_work', 'COMMIT',
  ]);
  assert.equal(new Set(calls.map(({ backend }) => backend)).size, 1);
  assert.deepEqual(calls[2].params, ['gdrive-folders:41'], 'preserve mutual exclusion with existing workers');
  assert.deepEqual(released, [undefined]);
}));

test('folder lock rolls back failed work and converts timeout into an actionable busy error', async () => {
  await withLockHarness({}, async ({ calls, released }) => {
    await assert.rejects(withOrgFolderLock(1, async () => { throw new Error('folder creation failed'); }), /folder creation failed/);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.deepEqual(released, [undefined]);
  });
  const failures = new Map([['SELECT pg_advisory_xact_lock(hashtext($1))', { code: '55P03' }]]);
  await withLockHarness({ failures }, async ({ calls, released }) => {
    await assert.rejects(withOrgFolderLock(1, () => assert.fail('must not enter protected work')), (err) => {
      assert.equal(err.code, 'GOOGLE_DRIVE_BUSY');
      assert.match(translateDriveError(err).message, /Retry the share/);
      return true;
    });
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.deepEqual(released, [undefined]);
  });
});

test('failed transaction cleanup discards the connection instead of returning an open transaction to the pool', async () => {
  const cleanupError = new Error('connection lost during rollback');
  await withLockHarness({ failures: new Map([['ROLLBACK', cleanupError]]) }, async ({ released }) => {
    await assert.rejects(withOrgFolderLock(1, () => { throw new Error('original error'); }), /original error/);
    assert.deepEqual(released, [cleanupError]);
  });
});

test('plot lock remains pinned until explicit idempotent release and uses a nonblocking transaction lock', async () => withLockHarness({}, async ({ calls, released }) => {
  const lock = await tryPlotShareLock(41, 83);
  assert.deepEqual(calls.map(({ sql }) => sql), ['BEGIN', 'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok']);
  assert.deepEqual(calls[1].params, ['gdrive-share:41:83']);
  assert.equal(released.length, 0, 'hold the dedicated client for the entire job');
  const first = lock.release();
  const second = lock.release();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.equal(new Set(calls.map(({ backend }) => backend)).size, 1);
  assert.deepEqual(released, [undefined]);
}));

test('busy and failed plot lock acquisition both end their transactions', async () => {
  await withLockHarness({ available: false }, async ({ calls, released }) => {
    assert.equal(await tryPlotShareLock(1, 2), null);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.deepEqual(released, [undefined]);
  });
  await withLockHarness({ failures: new Map([['SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', new Error('lock connection failed')]]) }, async ({ calls, released }) => {
    await assert.rejects(tryPlotShareLock(1, 2), /lock connection failed/);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
    assert.deepEqual(released, [undefined]);
  });
});

test('plot lock release rolls back after a failed COMMIT and discards broken cleanup connections', async () => {
  const commitError = new Error('commit failed');
  const cleanupError = new Error('rollback failed');
  await withLockHarness({ failures: new Map([['COMMIT', commitError], ['ROLLBACK', cleanupError]]) }, async ({ calls, released }) => {
    const lock = await tryPlotShareLock(1, 2);
    await assert.rejects(lock.release(), /commit failed/);
    assert.deepEqual(calls.slice(-2).map(({ sql }) => sql), ['COMMIT', 'ROLLBACK']);
    assert.deepEqual(released, [cleanupError]);
  });
});
