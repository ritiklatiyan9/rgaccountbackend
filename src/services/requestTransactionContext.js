import { AsyncLocalStorage } from 'node:async_hooks';

// Opt-in only. Normal requests keep pg's original checkout and query behavior.
export const requestTransactionContext = new AsyncLocalStorage();
const sqlText = value => typeof value === 'string' ? value : value?.text || '';
export function installRequestTransactionAdapter(pool) {
  const originalQuery = pool.query.bind(pool),
    originalConnect = pool.connect.bind(pool);
  pool.query = function (...args) {
    const context = requestTransactionContext.getStore();
    if (!context) return originalQuery(...args);
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    const promise = context.query(...args);
    if (callback) {
      promise.then(result => callback(null, result), callback);
      return;
    }
    return promise;
  };
  pool.connect = function (callback) {
    const context = requestTransactionContext.getStore();
    if (!context) return originalConnect(callback);
    const promise = context.lease();
    if (callback) {
      promise.then(client => callback(null, client, client.release), callback);
      return;
    }
    return promise;
  };
  return {
    originalQuery,
    originalConnect
  };
}
export function createRequestTransaction({
  connect,
  onWrite
}) {
  let connection,
    opening,
    closed = false,
    savepointSequence = 0;
  const activeSavepoints = [];
  const client = () => opening || (opening = requestTransactionContext.run(null, async () => {
    connection = await connect();
    try {
      await connection.query('BEGIN');
      return connection;
    } catch (error) {
      connection.release();
      closed = true;
      throw error;
    }
  }));
  const query = async (...args) => {
    if (closed) throw new Error('The request transaction has ended.');
    const db = await client(),
      result = await db.query(...args);
    // Several native payment controllers combine INSERT + accounting mirrors
    // in a CTE and return row_to_json(payment), rather than a flat RETURNING.
    const match = sqlText(args[0]).match(/\b(INSERT\s+INTO|UPDATE)\s+(?:public\.)?"?([a-z_]+)"?\b/i);
    if (match && result.rows?.length) await onWrite?.({
      table: match[2],
      creation: /^insert/i.test(match[1]),
      rows: result.rows.map(row => row.id ? row : row.payment?.id ? row.payment : row.entry?.id ? row.entry : row)
    });
    return result;
  };
  const lease = async () => {
    if (closed) throw new Error('The request transaction has ended.');
    const db = await client();
    let savepoint;
    return {
      release() {},
      query: async (...args) => {
        if (closed) throw new Error('The request transaction has ended.');
        const command = sqlText(args[0]).trim().replace(/;$/, '').toUpperCase();
        if (command === 'BEGIN') {
          if (savepoint) throw new Error('Nested BEGIN on the same database lease.');
          savepoint = `documentation_nested_${++savepointSequence}`;
          activeSavepoints.push(savepoint);
          return db.query(`SAVEPOINT ${savepoint}`);
        }
        if (command === 'COMMIT' || command === 'ROLLBACK') {
          if (!savepoint) throw new Error('No nested transaction is active.');
          if (activeSavepoints.at(-1) !== savepoint) throw new Error('Overlapping nested financial transactions must complete in order.');
          const name = savepoint;
          savepoint = undefined;
          activeSavepoints.pop();
          if (command === 'ROLLBACK') await db.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return db.query(`RELEASE SAVEPOINT ${name}`);
        }
        return query(...args);
      }
    };
  };
  return {
    query,
    lease,
    async finish(commit) {
      if (closed) return;
      closed = true;
      if (!opening) return;
      let db;
      try {
        db = await opening;
        await db.query(commit ? 'COMMIT' : 'ROLLBACK');
      } catch (error) {
        if (commit && db) await db.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        db?.release();
      }
    }
  };
}
