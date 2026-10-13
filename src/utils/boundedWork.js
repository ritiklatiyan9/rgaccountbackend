import { AsyncResource } from 'node:async_hooks';

const positiveInteger = (value, name) => {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
};

/** Bound admission, not just execution. Expired queued work never reaches the database. */
export function createBoundedWork(task, {
  concurrency = 2, maxPending = 32, queueTimeoutMs = 5000,
  busyError = () => Object.assign(new Error('Database reads are busy. Please retry shortly.'), {
    code: 'DATABASE_READ_BUSY', statusCode: 503,
  }),
} = {}) {
  positiveInteger(concurrency, 'concurrency');
  positiveInteger(maxPending, 'maxPending');
  positiveInteger(queueTimeoutMs, 'queueTimeoutMs');
  let active = 0, rejected = 0, completed = 0, peakActive = 0, peakPending = 0;
  const pending = [];
  const start = (item) => {
    if (item.timer) clearTimeout(item.timer);
    active += 1;
    peakActive = Math.max(peakActive, active);
    const settle = (failed, value) => {
      active -= 1;
      completed += 1;
      while (active < concurrency && pending.length) start(pending.shift());
      if (failed) item.reject(value); else item.resolve(value);
    };
    Promise.resolve().then(item.task).then(
      result => settle(false, result), error => settle(true, error),
    );
  };
  const run = (...args) => new Promise((resolve, reject) => {
    // A queued request may start inside a previous request's completion.
    // Preserve its caller context for request metrics and financial context.
    const item = { task: AsyncResource.bind(() => task(...args)), resolve, reject, timer: null };
    if (active < concurrency) return start(item);
    if (pending.length >= maxPending) { rejected += 1; reject(busyError()); return; }
    item.timer = setTimeout(() => {
      const index = pending.indexOf(item);
      if (index < 0) return;
      pending.splice(index, 1);
      rejected += 1;
      reject(busyError());
    }, queueTimeoutMs);
    pending.push(item);
    peakPending = Math.max(peakPending, pending.length);
  });
  run.getStats = () => ({ active, pending: pending.length, concurrency, maxPending,
    queueTimeoutMs, rejected, completed, peakActive, peakPending });
  return run;
}

/** Keep result order while creating only concurrency worker promises. */
export async function mapWithConcurrency(items, concurrency, mapper) {
  positiveInteger(concurrency, 'concurrency');
  const results = new Array(items.length);
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { failure = { error }; }
    }
  }));
  // Already-started queries finish before rejecting; no background tail is
  // left competing with the caller's retry after one worker fails.
  if (failure) throw failure.error;
  return results;
}

