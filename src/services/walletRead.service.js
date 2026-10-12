const busy = () => Object.assign(new Error('Cash Wallet is busy. Please retry in a few seconds.'), { code: 'WALLET_READ_BUSY', statusCode: 503 });

export function createWalletReadLimiter({ limit = 2, maxPending = 32, queueTimeoutMs = 5000 } = {}) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.resolve(release); }
    else active -= 1;
  };
  return {
    acquire() {
      if (active < limit) { active += 1; return Promise.resolve(release); }
      if (waiting.length >= maxPending) return Promise.reject(busy());
      return new Promise((resolve, reject) => {
        const item = { resolve, timer: null };
        item.timer = setTimeout(() => {
          const position = waiting.indexOf(item);
          if (position < 0) return;
          waiting.splice(position, 1); reject(busy());
        }, queueTimeoutMs);
        waiting.push(item);
      });
    },
  };
}

const limiters = new WeakMap();
function limiterFor(database) {
  let limiter = limiters.get(database);
  if (!limiter) {
    const configured = Number(process.env.WALLET_READ_CONCURRENCY || 2);
    const requested = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 3) : 2;
    const poolLimit = Math.max(1, Number(database.options?.max || 10) - 2);
    limiter = createWalletReadLimiter({ limit: Math.min(requested, poolLimit) });
    limiters.set(database, limiter);
  }
  return limiter;
}

// Bound expensive wallet reads on the server so they cannot monopolize the
// shared pool. SET LOCAL stays inside this read-only transaction and works
// through Neon's transaction pooler without changing other requests/migrations.
export async function walletReadQuery(database, sql, params = []) {
  const configured = Number(process.env.WALLET_READ_TIMEOUT_MS || 8000);
  const timeout = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 30000) : 8000;
  const releaseSlot = await limiterFor(database).acquire();
  let client;
  let discard;
  try {
    client = await database.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('statement_timeout',$1,true)", [`${timeout}ms`]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch (cleanupError) { discard = cleanupError; } }
    throw error;
  } finally {
    try { client?.release(discard); } finally { releaseSlot(); }
  }
}
