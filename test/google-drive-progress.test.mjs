import test from 'node:test';
import assert from 'node:assert/strict';
import { createShareProgress, createPreparedBundleCache, uploadPercent } from '../src/services/driveShareProgress.js';

test('live progress publishes before persistence and coalesces writes without reordering', async () => {
  const events = [];
  const persisted = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const progress = createShareProgress({
    publish: (p) => events.push(p),
    persist: async (p) => { if (p.sequence === 1) await gate; persisted.push(p); },
  });
  progress.update({ phase: 'folders', percent: 10 });
  progress.update({ phase: 'uploading', percent: 35 });
  progress.update({ percent: 80 });
  assert.equal(events.length, 3, 'socket updates cannot wait for a database response');
  assert.equal(persisted.length, 0);
  release();
  await progress.stop();
  assert.deepEqual(persisted.map((p) => p.sequence), [1, 3]);
  assert.equal(events[0].percent, 10, 'earlier snapshots must remain immutable');
  progress.update({ percent: 90 });
  assert.equal(events.length, 3, 'finished jobs ignore late transport callbacks');
});

test('progress stays monotonic through retry, never reaches 100 before terminal persistence', async () => {
  const events = [];
  const progress = createShareProgress({ publish: (p) => events.push(p), persist: async () => {} });
  progress.update({ percent: 80 });
  progress.update({ percent: 35, label: 'Retrying upload' });
  progress.update({ percent: 100 });
  await progress.stop();
  assert.deepEqual(events.map((p) => p.percent), [80, 80, 99]);
  assert.equal(uploadPercent(0, 1, [{ stage: 'uploading', bytes_sent: 100, bytes_total: 100 }]), 89);
  assert.equal(uploadPercent(1, 1, []), 95);
  assert.equal(uploadPercent(0, 1, [{ stage: 'downloading', bytes_sent: 100, bytes_total: 100 }]), 35);
});

test('throttled transport updates flush before stopping, even after a failed database write', async () => {
  const events = [];
  const writes = [];
  const errors = [];
  const progress = createShareProgress({
    publish: (p) => events.push(p),
    persist: async (p) => { writes.push(p); if (p.sequence === 1) throw new Error('database unavailable'); },
    onError: (err) => errors.push(err.message),
    throttleMs: 10000,
  });
  progress.update({ percent: 35 });
  progress.update({ percent: 60 }, { throttle: true });
  progress.update({ percent: 70 }, { throttle: true });
  assert.equal(events.length, 1);
  await progress.stop();
  assert.deepEqual(events.map((p) => p.sequence), [1, 3]);
  assert.equal(writes.at(-1).percent, 70);
  assert.deepEqual(errors, ['database unavailable']);
});

test('prepared data is one-use, bounded, fresh and discarded after a permission change', () => {
  let clock = 0;
  const cache = createPreparedBundleCache({ max: 2, ttlMs: 100, now: () => clock });
  const visibility = { canViewAll: true, creatorId: null };
  const bundle = { label: 'Plot A1' };
  cache.put(1, bundle, visibility);
  assert.equal(cache.take('1', visibility), bundle);
  assert.equal(cache.take(1, visibility), null);
  cache.put(2, bundle, visibility);
  assert.equal(cache.take(2, { canViewAll: false, creatorId: 8 }), null);
  cache.put(3, bundle, visibility);
  clock = 101;
  assert.equal(cache.take(3, visibility), null);
  cache.put(4, bundle, visibility);
  cache.put(5, bundle, visibility);
  cache.put(6, bundle, visibility);
  assert.equal(cache.take(4, visibility), null);
  assert.equal(cache.take(5, visibility), bundle);
  assert.equal(cache.take(6, visibility), bundle);
});
