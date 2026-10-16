import pool from '../src/config/db.js';

let db;
try {
  db = await pool.connect();
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='15000ms'");
  const source = (await db.query(`SELECT c.id,c.site_id,c.status,c.credit::text,c.debit::text,c.cash_type,
    c.source_module,c.source_id,c.created_by,c.created_at,to_jsonb(c)->>'approved_by' AS approved_by,
    to_jsonb(c)->>'approved_at' AS approved_at,to_jsonb(c)->>'deleted_at' AS deleted_at,
    c.cash_flow_month_id,m.ledger_type,m.ledger_name
    FROM cash_flow_entries c LEFT JOIN cash_flow_months m ON m.id=c.cash_flow_month_id WHERE c.id=75070`)).rows;
  const movements = (await db.query(`SELECT id,holder_key,site_id,kind,amount::text,source_table,source_id,
    details->>'status' AS saved_source_status,created_at FROM loyalty_vault_entries WHERE cash_flow_entry_id=75070 ORDER BY id`)).rows;
  const transfers = (await db.query(`SELECT id,from_holder_id,to_holder_id,amount::text,status,created_at,resolved_at,resolved_by
    FROM loyalty_vault_transfers WHERE site_id=2 AND (from_holder_id=5 OR to_holder_id=5) ORDER BY created_at`)).rows;
  await db.query('COMMIT');
  console.log(JSON.stringify({source,movements,transfers},null,2));
} catch (error) {
  await db?.query('ROLLBACK').catch(()=>{});
  console.error(JSON.stringify({code:error.code,message:error.message}));
  process.exitCode=1;
} finally { db?.release();await pool.end(); }
