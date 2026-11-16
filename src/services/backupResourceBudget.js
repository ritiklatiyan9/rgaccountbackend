import fs from 'node:fs/promises';

/** cgroup usage includes the API, backup process, native tools and page cache. */
export async function sharedBackupMemory({ readFile = fs.readFile, rss = process.memoryUsage().rss } = {}) {
  for (const [current, maximum] of [
    ['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
    ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes'],
  ]) {
    try {
      const [used, limit] = await Promise.all([readFile(current, 'utf8'), readFile(maximum, 'utf8')]);
      const bytes = Number(used.trim()); const cap = Number(limit.trim());
      if (Number.isFinite(bytes) && Number.isFinite(cap) && cap > 0 && cap < 2 ** 50) return { usedBytes: bytes, limitBytes: cap, rss };
    } catch { /* A deployment may use the other cgroup version. */ }
  }
  return { usedBytes: 0, limitBytes: Infinity, rss };
}

export function backupBudgetAllowsStart(memory) {
  return memory.usedBytes < memory.limitBytes * 0.65 && memory.rss < 128 * 1024 ** 2;
}

export function backupBudgetRequiresAbort(memory) {
  return memory.usedBytes >= memory.limitBytes * 0.85 || memory.rss >= 160 * 1024 ** 2;
}
