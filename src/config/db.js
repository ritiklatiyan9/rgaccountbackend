import 'dotenv/config';
import { BoundedPool, boundedInteger, databasePoolStats } from './boundedPool.js';
import { instrumentDatabaseClient } from '../utils/requestPerformance.js';
import { installRequestTransactionAdapter } from '../services/requestTransactionContext.js';

const sslOption = process.env.DB_SSL === 'true' || (process.env.DB_HOST && process.env.DB_HOST.includes('neon'))
  ? { rejectUnauthorized: false }
  : false;

const dbHost = process.env.DB_HOST;
const dbPort = process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : undefined;
const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD != null ? String(process.env.DB_PASSWORD) : '';
const poolMax = boundedInteger(process.env.DB_POOL_MAX, 10, 20);

const pool = new BoundedPool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: sslOption,
  // A page can issue several independent reads at once. Keeping the default at
  // 10 prevents a small managed PostgreSQL instance from running 20 reporting
  // queries concurrently and exhausting database memory; deployments can tune
  // it with DB_POOL_MAX (hard-capped at 20).
  max: poolMax,
  maxWaiting: boundedInteger(process.env.DB_POOL_MAX_WAITING, 64, 1024),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: boundedInteger(process.env.DB_CONNECTION_TIMEOUT_MS, 10000, 30000),
});

export const { originalConnect: connectOutsideRequestTransaction } = installRequestTransactionAdapter(pool);

// Safe operational metrics: never include connection options or credentials.
export const getDatabasePoolStats = () => databasePoolStats(pool);
pool.on('connect', instrumentDatabaseClient);

// PostgreSQL can close an idle connection during a restart or network outage.
// pg removes that client from the pool; handling its error keeps the API alive
// so later requests can obtain a fresh connection.
pool.on('error', (err) => {
  console.error('Idle PostgreSQL connection error:', err.message);
});

export const connectDB = async () => {
  try {
    const client = await pool.connect();
    console.log('Connected to PostgreSQL');
    client.release();
  } catch (err) {
    console.error('Database connection error', err);
    throw err;
  }
};

export default pool;
