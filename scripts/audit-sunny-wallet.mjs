import { writeFile } from 'node:fs/promises';
import pool from '../src/config/db.js';

// Evidence only: no source, balance or ledger updates are permitted here.
let db;
try {
  db = await pool.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='20000ms'");
  const report = {};
  report.checked_at = (await db.query('SELECT now() AS checked_at')).rows[0].checked_at;
  report.users = (await db.query("SELECT id,name,role,organization_id,is_active FROM users WHERE name ILIKE '%sunny%' ORDER BY id")).rows;
  const ids = report.users.map(user => user.id);
  report.migrations = (await db.query("SELECT version FROM app_schema_migrations WHERE version IN ('203_unified_cash_wallet','207_credit_wallet_imprest_debits','208_cash_wallet_site_scope','209_cash_wallet_receipt_details','210_wallet_balance_guards','211_locked_cash_collector','212_wallet_permanent_balance_guard') ORDER BY version")).rows;
  report.accounts = (await db.query(`SELECT holder_key,organization_id,balance::text,reserved_balance::text,updated_at
    FROM loyalty_vault_accounts WHERE holder_type='user' AND holder_id=ANY($1::int[]) ORDER BY holder_key`, [ids])).rows;
  report.site_balances = (await db.query(`SELECT e.holder_key,e.site_id,s.name AS site_name,count(*)::int AS entry_count,
    sum(e.amount)::text AS balance,sum(e.amount) FILTER(WHERE e.amount>0)::text AS credits,
    (-sum(e.amount) FILTER(WHERE e.amount<0))::text AS debits
    FROM loyalty_vault_entries e LEFT JOIN sites s ON s.id=e.site_id WHERE e.holder_type='user' AND e.holder_id=ANY($1::int[])
    GROUP BY e.holder_key,e.site_id,s.name ORDER BY e.holder_key,e.site_id`, [ids])).rows;
  report.entries = (await db.query(`SELECT e.id,e.organization_id,e.holder_key,e.site_id,s.name AS site_name,e.amount::text,
    e.balance_after::text,e.kind,e.description,e.source_table,e.source_id,e.cash_flow_entry_id,e.transfer_id,
    e.actor_id,e.details,e.created_at FROM loyalty_vault_entries e LEFT JOIN sites s ON s.id=e.site_id
    WHERE e.holder_type='user' AND e.holder_id=ANY($1::int[]) ORDER BY e.id LIMIT 1000`, [ids])).rows;
  report.transfers = (await db.query(`SELECT t.id,t.site_id,s.name AS site_name,t.from_holder_type,t.from_holder_id,
    giver.name AS from_name,t.to_holder_id,receiver.name AS to_name,t.sender_id,t.recipient_id,t.amount::text,
    t.status,t.note,t.created_at,t.resolved_at,t.resolution_note FROM loyalty_vault_transfers t
    LEFT JOIN sites s ON s.id=t.site_id LEFT JOIN users giver ON t.from_holder_type='user' AND giver.id=t.from_holder_id
    LEFT JOIN users receiver ON receiver.id=t.to_holder_id
    WHERE (t.from_holder_type='user' AND t.from_holder_id=ANY($1::int[])) OR t.to_holder_id=ANY($1::int[]) ORDER BY t.created_at`, [ids])).rows;
  report.sources = (await db.query(`SELECT v.*,to_jsonb(c) AS cash FROM loyalty_vault_sources v
    LEFT JOIN cash_flow_entries c ON c.id=v.cash_flow_entry_id WHERE v.holder_key=ANY($1::text[]) ORDER BY v.cash_flow_entry_id`, [ids.map(id => `user:${id}`)])).rows;
  report.negative_holders = (await db.query(`SELECT e.holder_key,u.name,e.site_id,s.name AS site_name,sum(e.amount)::text AS balance
    FROM loyalty_vault_entries e LEFT JOIN users u ON e.holder_type='user' AND e.holder_id=u.id LEFT JOIN sites s ON e.site_id=s.id
    GROUP BY e.holder_key,u.name,e.site_id,s.name HAVING sum(e.amount)<0 ORDER BY e.holder_key,e.site_id`)).rows;
  report.guards = (await db.query(`SELECT tgname,tgenabled FROM pg_trigger
    WHERE tgrelid='loyalty_vault_entries'::regclass AND tgname IN ('cash_wallet_nonnegative_entry','loyalty_vault_immutable_history') ORDER BY tgname`)).rows;
  if((await db.query("SELECT to_regclass('cash_wallet_voided_receipt_entries') AS name")).rows[0].name) {
    report.archived_debits = (await db.query(`SELECT original_entry_id,holder_key,site_id,cash_flow_entry_id,retained_amount::text,reason,voided_at
      FROM cash_wallet_voided_receipt_entries WHERE holder_key=ANY($1::text[]) ORDER BY original_entry_id`,[ids.map(id=>`user:${id}`)])).rows;
  }
  await db.query('COMMIT');
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(process.argv.includes('--summary') ? {checked_at:report.checked_at,accounts:report.accounts,
    site_balances:report.site_balances,migrations:report.migrations,guards:report.guards,archived_debits:report.archived_debits} : report, null, 2));
} catch (error) {
  if (db) await db.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ code: error.code, message: error.message }));
  process.exitCode = 1;
} finally { db?.release(); await pool.end(); }
