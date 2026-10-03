import { entryVisibilityKey } from './driveShareVisibility.js';

/** Live events never wait for a database round trip. Persist only the latest
 * snapshot, in order, so an older concurrent update cannot overwrite progress
 * or resurrect progress after a job has finished. */
export const createShareProgress = ({ initial, publish, persist, onError = () => {}, now = Date.now, throttleMs = 200 }) => {
  let current = {
    sequence: 0, phase: 'queued', label: 'Waiting for uploader', percent: 0,
    done: 0, total: 0, files_done: 0, files_total: 0, active_files: [], ...initial,
  };
  let pending = null;
  let writing = null;
  let timer = null;
  let stopped = false;
  let lastPublished = -Infinity;

  const drain = () => {
    if (writing) return writing;
    writing = (async () => {
      while (pending) {
        const snapshot = pending;
        pending = null;
        try { await persist(snapshot); } catch (err) { onError(err); }
      }
    })().finally(() => { writing = null; if (pending) drain(); });
    return writing;
  };
  const emit = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastPublished = now();
    publish(current);
    pending = current;
    drain();
  };
  const update = (patch, { throttle = false } = {}) => {
    if (stopped) return current;
    current = {
      ...current, ...patch,
      percent: Math.min(99, Math.max(current.percent, Number(patch.percent ?? current.percent) || 0)),
      sequence: current.sequence + 1,
      updated_at: new Date(now()).toISOString(),
    };
    if (!throttle || now() - lastPublished >= throttleMs) emit();
    else if (!timer) {
      timer = setTimeout(emit, throttleMs - (now() - lastPublished));
      timer.unref?.();
    }
    return current;
  };
  const stop = async () => {
    stopped = true;
    if (timer) emit();
    while (writing || pending) await (writing || drain());
    return current;
  };
  return { update, stop, get current() { return current; } };
};

/** Progress represents completed work, not an estimated number of seconds.
 * Uploaded bytes account for at most 90% of a file's unit: only Google's
 * successful response completes the unit. */
export const uploadPercent = (done, total, activeFiles) => {
  const inFlight = activeFiles.reduce((sum, file) => sum + (
    file.stage === 'uploading' && file.bytes_total > 0
      ? Math.min(0.9, Math.max(0, file.bytes_sent / file.bytes_total) * 0.9) : 0
  ), 0);
  return Math.min(95, 35 + 60 * Math.min(1, (done + inFlight) / Math.max(total, 1)));
};

/** The POST already builds and authorizes a bundle. Reuse that snapshot for
 * an immediately starting job only; restarts, queues and changed permissions
 * rebuild from the database. The cache is bounded and never persisted. */
export const createPreparedBundleCache = ({ max = 4, ttlMs = 15000, now = Date.now } = {}) => {
  const entries = new Map();
  return {
    put(id, bundle, visibility) {
      for (const [key, entry] of entries) if (now() - entry.at > ttlMs) entries.delete(key);
      if (entries.size >= max) entries.delete(entries.keys().next().value);
      entries.set(String(id), { bundle, visibility: entryVisibilityKey(visibility), at: now() });
    },
    take(id, visibility) {
      const entry = entries.get(String(id));
      entries.delete(String(id));
      return entry && now() - entry.at <= ttlMs && entry.visibility !== null && entry.visibility === entryVisibilityKey(visibility)
        ? entry.bundle : null;
    },
  };
};
