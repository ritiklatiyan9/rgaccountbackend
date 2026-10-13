import pg from 'pg';
import { AsyncResource } from 'node:async_hooks';

/** pg already limits live connections; also cap its otherwise unbounded checkout queue. */
export class BoundedPool extends pg.Pool {
  constructor({ maxWaiting = 64, ...options } = {}) {
    if (!Number.isInteger(maxWaiting) || maxWaiting < 1) throw new RangeError('maxWaiting must be a positive integer');
    super(options);
    this.maxWaiting = maxWaiting;
    this.rejectedCheckouts = 0;
  }

  connect(callback) {
    if (!this.ending && this.totalCount >= this.options.max && this.waitingCount >= this.maxWaiting) {
      this.rejectedCheckouts += 1;
      const error = Object.assign(new Error('Database connection queue is full. Please retry shortly.'), {
        code: 'DATABASE_POOL_BUSY', statusCode: 503,
      });
      if (callback) { process.nextTick(callback, error); return; }
      return this.Promise.reject(error);
    }
    // pg-pool invokes queued callbacks from another client's release path.
    // Restore the requesting context before pool.query calls client.query.
    return super.connect(typeof callback === 'function' ? AsyncResource.bind(callback) : callback);
  }
}

export function databasePoolStats(pool) {
  return { max: pool.options.max, total: pool.totalCount, idle: pool.idleCount,
    active: pool.totalCount - pool.idleCount, waiting: pool.waitingCount,
    maxWaiting: pool.maxWaiting, rejectedCheckouts: pool.rejectedCheckouts };
}

export function boundedInteger(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
