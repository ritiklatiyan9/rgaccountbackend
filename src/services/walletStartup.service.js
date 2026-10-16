import pool from '../config/db.js';
import { up as vault } from '../migrations/199_loyalty_vault.js';
import { up as unified } from '../migrations/203_unified_cash_wallet.js';
import { up as indexes } from '../migrations/204_cash_wallet_read_indexes.js';
import { up as funding } from '../migrations/207_credit_wallet_imprest_debits.js';
import { up as scope } from '../migrations/208_cash_wallet_site_scope.js';
import { up as details, cashWalletReceiptDetailsSql } from '../migrations/209_cash_wallet_receipt_details.js';
import { up as balances, walletBalanceGuardsSql } from '../migrations/210_wallet_balance_guards.js';
import { up as collector } from '../migrations/211_locked_cash_collector.js';
import { up as permanent } from '../migrations/212_wallet_permanent_balance_guard.js';

export const walletStartupMigrations = Object.freeze([
  ['199_loyalty_vault', vault],
  ['203_unified_cash_wallet', unified],
  ['204_cash_wallet_read_indexes', indexes],
  ['207_credit_wallet_imprest_debits', funding],
  ['208_cash_wallet_site_scope', scope],
  ['209_cash_wallet_receipt_details', details],
  ['210_wallet_balance_guards', balances],
  ['211_locked_cash_collector', collector],
  ['212_wallet_permanent_balance_guard', permanent],
]);

export const walletRuntimeFunctions = [
  ['reconcile_loyalty_vault_entry', cashWalletReceiptDetailsSql],
  ['loyalty_vault_apply_delta', walletBalanceGuardsSql],
].map(([name, source]) => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = source.indexOf('$$;', start) + 3;
  if (start < 0 || end <= start) throw new Error(`Wallet startup definition missing: ${name}`);
  const sql = source.slice(start, end);
  return { name, sql, body: sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).trim() };
});

async function ensureRuntimeFunctions(database) {
  const { rows } = await database.query(`SELECT p.proname AS name,p.prosrc AS body FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname=ANY($1::text[])`,
  [walletRuntimeFunctions.map(fn => fn.name)]);
  const stale = walletRuntimeFunctions.filter(fn => !rows.some(row => row.name === fn.name && row.body.trim() === fn.body));
  if (!stale.length) return [];
  // A previous boot can commit migration 199 and fail before 209/210. Repair
  // only those shared function definitions, without source-table ALTERs,
  // trigger rebuilds, reconciliation, or account updates.
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query(walletRuntimeFunctions.map(fn => fn.sql).join('\n'));
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
  return stale.map(fn => fn.name);
}

// Rebuilding an installed wallet schema upgrades locks across source tables,
// users and wallet history. Live reads can hold those tables in the opposite
// order, deadlocking a deployment before it can bind its port.
export async function ensureWalletStartup(database = pool, migrations = walletStartupMigrations) {
  const { rows } = await database.query(
    'SELECT version FROM app_schema_migrations WHERE version=ANY($1::text[])',
    [migrations.map(([version]) => version)],
  );
  const installed = new Set(rows.map(row => row.version));
  const firstMissing = migrations.findIndex(([version]) => !installed.has(version));
  if (firstMissing === -1) {
    const repaired = await ensureRuntimeFunctions(database);
    return { applied: [], current: true, repaired };
  }

  // Earlier migrations replace shared SQL functions. When an upgrade is
  // required, finish its entire tail so the final guards stay installed even
  // if some later migration markers were already present.
  const applied = [];
  for (const [version, migrate] of migrations.slice(firstMissing)) {
    await migrate(database);
    applied.push(version);
  }
  return { applied, current: false, repaired: [] };
}
