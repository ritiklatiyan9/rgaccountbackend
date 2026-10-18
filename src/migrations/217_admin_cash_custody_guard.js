import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { siteCashDebitSql } from './207_credit_wallet_imprest_debits.js';

export const VERSION = '217_admin_cash_custody_guard';

// Keep the financial calculation and source edit/reversal rules from 207.
// Only the final availability check changes; installing this migration never
// reconciles a receipt, posts a movement, or updates a financial balance.
function definition(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  const end = source.indexOf('$$;', start) + 3;
  if (start < 0 || end <= start) throw new Error(`Missing cash funding definition: ${name}`);
  return source.slice(start, end);
}

const financialCashSql = definition(siteCashDebitSql, 'imprest_available_site_cash')
  .replace('FUNCTION imprest_available_site_cash(', 'FUNCTION imprest_financial_site_cash(');
const previousCheck = 'available:=imprest_available_site_cash(p_site_id)+own_hold+own_posted;';
const debitSql = definition(siteCashDebitSql, 'reconcile_site_cash_debit');
if (!debitSql.includes(previousCheck)) throw new Error('Missing Admin cash debit funding check');

export const adminCashCustodySql = `
${financialCashSql}

CREATE OR REPLACE FUNCTION cash_wallet_cap_admin_cash(p_site integer, p_financial_available numeric)
RETURNS numeric LANGUAGE sql VOLATILE AS $$
  WITH scope AS (SELECT organization_id FROM sites WHERE id=p_site),
  aligned AS (
    SELECT DISTINCT e.holder_key FROM loyalty_vault_entries e
    JOIN users u ON e.holder_type='user' AND u.id=e.holder_id
    JOIN scope s ON s.organization_id=e.organization_id AND u.organization_id=s.organization_id
    WHERE e.site_id=p_site AND u.role='admin'
      AND e.source_table='manual_wallet_site_cash_alignment'
  ), wallets AS (
    SELECT e.holder_key,SUM(e.amount) AS balance FROM loyalty_vault_entries e
    JOIN scope s ON s.organization_id=e.organization_id
    WHERE e.site_id=p_site GROUP BY e.holder_key
  )
  SELECT LEAST(p_financial_available,COALESCE((
    SELECT MIN(LEAST(w.balance,p_financial_available-COALESCE((
      SELECT SUM(GREATEST(other.balance,0)) FROM wallets other WHERE other.holder_key<>a.holder_key
    ),0))) FROM aligned a JOIN wallets w USING(holder_key)
  ),p_financial_available))
$$;

CREATE OR REPLACE FUNCTION imprest_available_site_cash(p_site integer, p_exclude_pending integer DEFAULT NULL)
RETURNS numeric LANGUAGE sql VOLATILE AS $$
  SELECT cash_wallet_cap_admin_cash(p_site,imprest_financial_site_cash(p_site,p_exclude_pending))
$$;

${debitSql.replace(previousCheck,
  'available:=cash_wallet_cap_admin_cash(p_site_id,imprest_financial_site_cash(p_site_id)+own_hold+own_posted);')}

${definition(siteCashDebitSql, 'reconcile_imprest_debit')}
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('217_admin_cash_custody_guard'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await db.query(adminCashCustodySql);
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [VERSION]);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 217: Admin cash spending and Imprest share Wallet custody limits'))
    .catch(error => { console.error('Migration 217 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
