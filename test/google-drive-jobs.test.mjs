import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createShareProgress, createPreparedBundleCache, uploadPercent } from '../src/services/driveShareProgress.js';

// Execute the real runner with explicit dependencies. Only ES module wiring is
// removed: no runner logic is rewritten, and no DB/Google client is imported.
const runnerSource = (await readFile(new URL('../src/services/driveShareJobs.service.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];$/gm, '')
  .replace(/^export /gm, '');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const shareFixture = (overrides = {}) => ({
  id: 42, organization_id: 3, site_id: 2, entity_id: 20, shared_by: 8,
  scope: 'overall', payment_id: null, status: 'running', progress: null,
  request: { formats: ['xlsx'], include_documents: false }, ...overrides,
});
const statement = { folder: 'Transaction Details', name: 'Commission Statement - Plot A1', kind: 'statement', formats: ['xlsx'] };
const attachment = { folder: 'Documents', name: 'Proof.png', kind: 'voucher', source: 'proof.png', size: 10 };

const makeRunner = ({ share = shareFixture(), plan = [statement], visibility = { canViewAll: true, creatorId: null }, upload, build, authorize, finishGate, lock = true, claim } = {}) => {
  const calls = { events: [], queries: [], uploads: [], builds: [], plans: [], siteChecks: [], releases: 0, html: 0, pdf: 0, reads: 0, folders: 0 };
  let committed = null;
  const user = { id: 8, role: 'admin', email: 'admin@example.test' };
  const bundle = { site: { name: 'Defence Garden' }, folderSegments: ['03-10-2026', 'Project Commission', 'Plot A1'] };
  const deps = {
    pool: {
      query: async (sql, values) => {
        calls.queries.push({ sql, values });
        if (sql.includes('SELECT id, role, email FROM users')) return { rows: [user] };
        if (sql.includes('finished_at=NOW()')) {
          finishGate?.entered.resolve();
          if (finishGate) await finishGate.release.promise;
          committed = {
            ...share, status: values[1], files: JSON.parse(values[2]), error: values[3],
            folder_id: values[4], folder_url: values[5], progress: JSON.parse(values[6]),
          };
          return { rows: [committed] };
        }
        if (sql.includes('INSERT INTO google_drive_shares')) return { rows: [{ ...share, status: 'queued' }] };
        if (sql.includes("SET status='running', started_at=NOW()")) return { rows: claim ? await claim() : [] };
        if (sql.includes('UPDATE google_drive_shares SET progress=')) return { rows: [] };
        if (sql.includes("SET status='queued', started_at=NULL")) return { rows: [] };
        assert.fail(`Unexpected SQL: ${sql}`);
      },
    },
    emitToUser: (userId, event, row) => calls.events.push({ userId, event, row: structuredClone(row), committed: Boolean(committed) }),
    resolveEntryVisibility: async (actualUser, module) => {
      assert.deepEqual(actualUser, user);
      assert.equal(module, 'commissions');
      return visibility;
    },
    assertCommissionSite: async (...args) => {
      calls.siteChecks.push(args);
      if (authorize) await authorize(...args);
    },
    createShareProgress, createPreparedBundleCache, uploadPercent,
    driveClientFor: async (orgId) => {
      assert.equal(orgId, 3);
      return { drive: { files: { delete: async () => {} } } };
    },
    ensureSiteFolder: async () => { calls.folders += 1; return { id: 'site-folder', key: 'Site' }; },
    ensureFolderPath: async () => 'record-folder',
    ensureSubfolders: async (_ctx, _base, groups) => new Map(groups.map((group) => [group, `folder:${group}`])),
    listChildren: async () => new Map(),
    upsertFile: async (_ctx, options) => {
      calls.uploads.push(options);
      if (upload) return upload(options, calls.uploads.length);
      return { id: `file-${calls.uploads.length}`, url: 'https://drive.example/file', created: true };
    },
    exportPdf: async () => { calls.pdf += 1; return Buffer.from('pdf'); },
    folderPathKey: (segments) => segments.join('/'),
    folderUrl: (id) => `https://drive.example/folders/${id}`,
    tryPlotShareLock: async (orgId, plotId) => {
      assert.deepEqual([orgId, plotId], [3, 20]);
      return lock ? { release: async () => { calls.releases += 1; } } : null;
    },
    translateDriveError: () => ({ message: 'Google Drive request failed' }),
    markReauthorizationRequired: async () => {},
    buildPlotCommissionShareBundle: async (args) => {
      calls.builds.push(args);
      return build ? build(args) : bundle;
    },
    renderStatementHtml: () => { calls.html += 1; return '<html>statement</html>'; },
    renderProfileHtml: () => { calls.html += 1; return '<html>profile</html>'; },
    buildStatementXlsx: () => Buffer.alloc(100),
    planShareFiles: (actualBundle, options) => { calls.plans.push({ bundle: actualBundle, options }); return plan; },
    readStoredFileBytes: async () => { calls.reads += 1; return { bytes: Buffer.alloc(10), mime_type: 'image/png' }; },
  };
  const runner = new Function(...Object.keys(deps), `${runnerSource}\nreturn { runShareJob, enqueueShare, kickShareRunner };`)(...Object.values(deps));
  return { ...runner, calls, share, bundle, visibility, get committed() { return committed; } };
};

test('Excel-only job streams phases/bytes, then reports 100% only after the result commits', async () => {
  const finishGate = { entered: deferred(), release: deferred() };
  const h = makeRunner({
    finishGate,
    upload: async ({ onUploadProgress }) => {
      onUploadProgress({ bytes_sent: 30, bytes_total: 100 });
      await delay(220); // Let the real 200 ms reporter flush the intermediate bytes.
      onUploadProgress({ bytes_sent: 100, bytes_total: 100 });
      return { id: 'excel-file', url: 'https://drive.example/excel', created: true };
    },
  });
  const job = h.runShareJob(h.share);
  await finishGate.entered.promise;
  assert.equal(h.calls.uploads.length, 1);
  const uploaded = h.calls.uploads[0];
  assert.match(uploaded.name, /\.xlsx$/);
  assert.equal(uploaded.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(uploaded.convertTo, undefined);
  assert.equal(h.calls.html, 0);
  assert.equal(h.calls.pdf, 0);
  assert.equal(h.calls.reads, 0);
  assert.equal(h.calls.builds[0].includeDocuments, false);
  assert.deepEqual(h.calls.siteChecks, [[{ id: 8, role: 'admin', email: 'admin@example.test' }, 2]]);

  const snapshots = h.calls.events.map((e) => e.row.progress);
  assert.deepEqual([...new Set(snapshots.map((p) => p.phase))], ['preparing', 'folders', 'uploading', 'finalizing']);
  assert.ok(snapshots.some((p) => p.active_files.some((f) => f.bytes_sent === 30 && f.bytes_total === 100)));
  assert.ok(snapshots.every((p) => p.percent < 100));
  assert.ok(h.calls.events.every((e) => e.event === 'drive_share:progress' && e.userId === 8 && !e.committed));
  for (let i = 1; i < snapshots.length; i += 1) {
    assert.ok(snapshots[i].sequence > snapshots[i - 1].sequence);
    assert.ok(snapshots[i].percent >= snapshots[i - 1].percent);
  }

  finishGate.release.resolve();
  const result = await job;
  assert.equal(result.status, 'completed');
  assert.equal(result.progress.percent, 100);
  assert.equal(result.progress.files_done, 1);
  assert.equal(result.progress.files_total, 1);
  assert.equal(h.calls.events.filter((e) => e.event === 'drive_share:done').length, 1);
  assert.equal(h.calls.events.at(-1).committed, true);
  assert.equal(h.calls.releases, 1);
  assert.ok(h.calls.queries.filter(({ sql }) => sql.includes('SET progress=')).every(({ sql }) => sql.includes("status='running'")));
  assert.ok(h.calls.queries.at(-1).sql.includes('finished_at=NOW()'));
});

test('an ambiguous upload failure rechecks Drive on retry, publishes retrying and completes one unit', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = makeRunner({ upload: async (_options, attempt) => {
    // Drive may have saved the first request before returning its 503.
    if (attempt === 1) throw Object.assign(new Error('Response unavailable'), { code: 503 });
    return { id: 'retried-file', url: 'https://drive.example/retried', created: false };
  } });
  const result = await h.runShareJob(h.share);
  assert.equal(h.calls.uploads.length, 2);
  assert.equal(h.calls.uploads[0].existing, null, 'initial attempt uses the prepared folder listing');
  assert.equal(h.calls.uploads[1].existing, undefined, 'retry must re-list to find a file saved by the ambiguous attempt');
  assert.equal(h.calls.uploads[0].name, h.calls.uploads[1].name);
  assert.deepEqual(h.calls.uploads[0].body, h.calls.uploads[1].body);
  assert.equal(result.status, 'completed');
  assert.equal(result.files.length, 1);
  assert.equal(result.progress.files_done, 1);
  assert.ok(h.calls.events.some((e) => e.row.progress.active_files.some((f) => f.stage === 'retrying')));
  assert.equal(h.calls.releases, 1);
});

test('mixed outcomes remain partial and permanent failures are not retried', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = makeRunner({
    share: shareFixture({ request: { formats: ['xlsx'], include_documents: true } }),
    plan: [statement, attachment],
    upload: async ({ name }) => {
      if (name === 'Proof.png') throw Object.assign(new Error('Forbidden'), { code: 403 });
      return { id: 'excel-file', url: 'https://drive.example/excel', created: true };
    },
  });
  const result = await h.runShareJob(h.share);
  assert.equal(h.calls.uploads.length, 2);
  assert.equal(h.calls.builds[0].includeDocuments, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.progress.percent, 100);
  assert.equal(result.progress.files_done, 2);
  assert.equal(result.files[0].error, null);
  assert.equal(result.files[1].error, 'Google Drive request failed');
  assert.match(result.error, /1 of 2 files skipped: Proof.png/);
});

test('a failed Excel upload never produces a successful 100% event', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = makeRunner({ upload: async () => { throw Object.assign(new Error('Forbidden'), { code: 403 }); } });
  const result = await h.runShareJob(h.share);
  assert.equal(result.status, 'failed');
  assert.equal(result.files.length, 1);
  assert.ok(result.files[0].error);
  assert.ok(h.calls.events.every((e) => e.row.progress.percent < 100));
  assert.equal(h.calls.events.at(-1).event, 'drive_share:done');
  assert.equal(h.calls.releases, 1);
});

test('job rechecks site/full-statement permissions before building or uploading', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const options of [
    { visibility: { canViewAll: false, creatorId: '8' } },
    { authorize: async () => { throw Object.assign(new Error('Site access denied'), { statusCode: 403 }); } },
  ]) {
    const h = makeRunner(options);
    const result = await h.runShareJob(h.share);
    assert.equal(result.status, 'failed');
    assert.equal(h.calls.siteChecks.length, 1);
    assert.equal(h.calls.builds.length, 0);
    assert.equal(h.calls.folders, 0);
    assert.equal(h.calls.uploads.length, 0);
    assert.equal(h.calls.releases, 1);
  }
});

test('transaction job retains payment ID and creator visibility; an inaccessible payment fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const inaccessible of [false, true]) {
    const h = makeRunner({
      share: shareFixture({ scope: 'transaction', payment_id: '17' }),
      visibility: { canViewAll: false, creatorId: '8' },
      build: (args) => {
        assert.equal(args.scope, 'transaction');
        assert.equal(args.paymentId, 17);
        assert.deepEqual(args.entryVisibility, { canViewAll: false, creatorId: '8' });
        if (inaccessible) throw Object.assign(new Error('Payment not found for this plot'), { statusCode: 404 });
        return { site: { name: 'Defence Garden' }, folderSegments: ['Plot A1'] };
      },
    });
    const result = await h.runShareJob(h.share);
    assert.equal(result.status, inaccessible ? 'failed' : 'completed');
    assert.equal(h.calls.uploads.length, inaccessible ? 0 : 1);
    if (inaccessible) assert.match(result.error, /Payment not found/);
  }
});

test('prepared bundle is reused only after authorization and matching visibility', async () => {
  for (const changedVisibility of [false, true]) {
    const h = makeRunner();
    const prepared = { bundle: h.bundle, entryVisibility: changedVisibility ? { canViewAll: true, creatorId: 'old' } : h.visibility };
    await h.enqueueShare({ orgId: 3, siteId: 2, plotId: 20, scope: 'overall', userId: 8, request: h.share.request, prepared });
    const result = await h.runShareJob(h.share);
    assert.equal(result.status, 'completed');
    assert.equal(h.calls.siteChecks.length, 1);
    assert.equal(h.calls.builds.length, changedVisibility ? 1 : 0);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('busy plot is requeued without creating or uploading any files', async () => {
  const h = makeRunner({ lock: false });
  await h.runShareJob(h.share);
  assert.equal(h.calls.builds.length, 0);
  assert.equal(h.calls.uploads.length, 0);
  assert.equal(h.calls.events.length, 0);
  assert.ok(h.calls.queries.some(({ sql }) => sql.includes("SET status='queued', started_at=NULL")));
});

test('a refused plot lock waits for the next sweep instead of immediately reclaiming the same row', async () => {
  const share = shareFixture();
  let claims = 0;
  const h = makeRunner({
    share, lock: false,
    claim: async () => {
      // Let any just-launched lock attempt requeue its row before this query
      // resolves, reproducing a fast refusal racing a slower queue query.
      await new Promise((resolve) => setImmediate(resolve));
      claims += 1;
      return claims <= 3 ? [share] : [];
    },
  });
  await h.kickShareRunner();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claims, 1);
  assert.equal(h.calls.queries.filter(({ sql }) => sql.includes("SET status='queued', started_at=NULL")).length, 1);
  assert.equal(h.calls.uploads.length, 0);
});
