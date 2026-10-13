import pool from './db.js';
import { boundedInteger } from './boundedPool.js';
import { createBoundedWork } from '../utils/boundedWork.js';

// Ledger aggregations need substantially more memory than ordinary reads.
// Share this limit across KPI and chart requests, rather than letting each
// dashboard fill the connection pool with reporting queries at once.
export function createFinancialReadQueue(query, concurrency = 2, options = {}) {
  return createBoundedWork(query, { ...options, concurrency });
}

const concurrency = Math.min(2, Math.max(1, pool.options.max - 2));
const query = createFinancialReadQueue((...args) => pool.query(...args), concurrency, {
  maxPending: boundedInteger(process.env.FINANCIAL_READ_MAX_PENDING, 32, 256),
  queueTimeoutMs: boundedInteger(process.env.FINANCIAL_READ_QUEUE_TIMEOUT_MS, 5000, 30000),
});

export default {
  query,
  getStats: query.getStats,
};
