import pool from './db.js';

// Ledger aggregations need substantially more memory than ordinary reads.
// Share this limit across KPI and chart requests, rather than letting each
// dashboard fill the connection pool with reporting queries at once.
export function createFinancialReadQueue(query, concurrency = 2) {
  let active = 0;
  const pending = [];

  const drain = () => {
    while (active < concurrency && pending.length) {
      const { args, resolve, reject } = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => query(...args))
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return (...args) => new Promise((resolve, reject) => {
    pending.push({ args, resolve, reject });
    drain();
  });
}

export default {
  query: createFinancialReadQueue((...args) => pool.query(...args)),
};
