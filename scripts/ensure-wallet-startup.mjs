import pool from '../src/config/db.js';
import { ensureWalletStartup } from '../src/services/walletStartup.service.js';

try {
  const result = await ensureWalletStartup(pool);
  console.log(result.repaired.length ? `Cash Wallet runtime functions restored: ${result.repaired.join(', ')}` : result.current ? 'Cash Wallet schema is current; no startup DDL needed.'
    : `Cash Wallet schema upgraded: ${result.applied.join(', ')}`);
} catch (error) {
  console.error('Cash Wallet startup failed:', error.message);
  process.exitCode = 1;
} finally { await pool.end(); }
