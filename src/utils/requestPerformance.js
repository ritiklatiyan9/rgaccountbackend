import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const context = new AsyncLocalStorage();
const instrumented = Symbol('performanceQuery');

// Install on pg's public "connect" event. It includes pooled reads and queries
// on checked-out transaction clients, without changing SQL or transactions.
export function instrumentDatabaseClient(client) {
  if (client[instrumented]) return;
  client[instrumented] = true;
  const query = client.query;
  client.query = function (...args) {
    const metrics = context.getStore();
    if (!metrics) return query.apply(this, args);
    const start = performance.now();
    metrics.query_count += 1;
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      const ms = performance.now() - start;
      metrics.query_total_ms += ms;
      metrics.query_slowest_ms = Math.max(metrics.query_slowest_ms, ms);
    };
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = args[last];
      args[last] = (...values) => { finish(); return callback(...values); };
    } else if (typeof args[0]?.callback === 'function') {
      const callback = args[0].callback;
      args[0] = { ...args[0], callback: (...values) => { finish(); return callback(...values); } };
    }
    try {
      const result = query.apply(this, args);
      if (result?.then) return result.then(value => { finish(); return value; }, error => { finish(); throw error; });
      if (result?.once) { result.once('end', finish); result.once('error', finish); }
      return result;
    } catch (error) { finish(); throw error; }
  };
}

// Opt-in, no SQL, query strings, user identifiers, headers, bodies or balances.
export function requestPerformance({
  enabled = () => process.env.API_PERFORMANCE_LOG === 'true',
  log = record => console.info(JSON.stringify(record)),
  poolStats = () => ({}),
} = {}) {
  return (req, res, next) => {
    if (!enabled()) return next();
    const metrics = { query_count: 0, query_total_ms: 0, query_slowest_ms: 0 };
    const start = performance.now();
    let finished = false;
    const report = () => {
      if (finished) return;
      finished = true;
      log({ type: 'api-performance', method: req.method,
        // An unmatched path may contain a capability token; log a fixed label.
        route: req.route?.path || 'unmatched',
        status: res.statusCode, duration_ms: +(performance.now() - start).toFixed(2),
        payload_bytes: Number(res.getHeader('content-length')) || 0,
        query_count: metrics.query_count, query_total_ms: +metrics.query_total_ms.toFixed(2),
        query_slowest_ms: +metrics.query_slowest_ms.toFixed(2),
        pool: poolStats(), rss_bytes: process.memoryUsage().rss });
    };
    res.once('finish', report);
    res.once('close', report);
    context.run(metrics, next);
  };
}
