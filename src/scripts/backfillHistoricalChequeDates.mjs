import assert from 'node:assert/strict';
import pool from '../config/db.js';
import { up, CUTOFF } from '../migrations/216_historical_cheque_entry_dates.js';

// Dry-run by default. Both modes exercise the real triggers and reject any
// unexpected change to the existing financial ledgers before committing.
const apply = process.argv.includes('--apply');
const client = await pool.connect();
const fingerprint = async () => {
  const result = {};
  result.cashFlow = (await client.query(`SELECT jsonb_agg(t ORDER BY site_id,mode,status,cheque_status) AS totals FROM (
    SELECT site_id,cash_type AS mode,status,cheque_status,COUNT(*) AS entries,SUM(debit) AS debit,SUM(credit) AS credit
    FROM cash_flow_entries GROUP BY 1,2,3,4
  ) t`)).rows[0].totals;
  for (const table of ['imprest_ledger','imprest_debit_reservations','tds_deductions','loyalty_vault_accounts','loyalty_vault_entries','loyalty_vault_sources']) {
    result[table] = (await client.query(`SELECT md5(COALESCE(jsonb_agg(to_jsonb(t)-'updated_at' ORDER BY to_jsonb(t)::text)::text,'[]')) AS digest FROM ${table} t`)).rows[0].digest;
  }
  return result;
};
let before;
let sites = [];
try {
  const result = await up({connect:async()=>({
    release() {},
    async query(sql,params) {
      if (sql === 'BEGIN') {
        const response = await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        before = await fingerprint();
        return response;
      }
      if (sql === 'COMMIT') {
        assert.deepEqual(await fingerprint(),before,'Historical cheque dates must not change accounting amounts, TDS, wallet or imprest ledgers');
        const audit = await client.query("SELECT to_regclass('public.cheque_date_backfill_history') IS NOT NULL AS present");
        if (audit.rows[0].present) sites = (await client.query(`SELECT (before_row->>'site_id')::int AS site_id,COUNT(*)::int AS entries
          FROM cheque_date_backfill_history WHERE cutoff_at=$1::timestamptz GROUP BY 1 ORDER BY 1`,[CUTOFF])).rows;
        return client.query(apply ? 'COMMIT' : 'ROLLBACK');
      }
      return client.query(sql,params);
    },
  })});
  console.log(JSON.stringify({mode:apply?'applied':'dry-run rolled back',...result,sites,financial_checks:'unchanged'},null,2));
} finally { client.release(); await pool.end(); }
