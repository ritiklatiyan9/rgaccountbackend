import { writeFile } from 'node:fs/promises';
import pool from '../src/config/db.js';

// Read-only evidence. Never infer a site's cash from organization-wide caches.
let client;
try {
  client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='20000ms'");
  const report = {};
  report.checked_at = (await client.query('SELECT now() AS checked_at')).rows[0].checked_at;
  report.sites = (await client.query('SELECT id,name,organization_id FROM sites ORDER BY id')).rows;
  report.holders = (await client.query("SELECT id,name,role,organization_id FROM users WHERE name ILIKE '%sachin%' ORDER BY id")).rows;
  const holderIds = report.holders.map(row => row.id);
  report.site_balances = (await client.query(`SELECT e.holder_key,e.site_id,s.name AS site_name,
      count(*)::int AS entries,sum(e.amount)::text AS balance,min(e.created_at) AS first_posted_at,max(e.created_at) AS last_posted_at
    FROM loyalty_vault_entries e LEFT JOIN sites s ON s.id=e.site_id
    WHERE e.holder_type='user' AND e.holder_id=ANY($1::int[])
    GROUP BY e.holder_key,e.site_id,s.name ORDER BY e.holder_key,e.site_id`,[holderIds])).rows;
  report.global_accounts = (await client.query(`SELECT holder_key,organization_id,balance::text,reserved_balance::text,updated_at
    FROM loyalty_vault_accounts WHERE holder_type='user' AND holder_id=ANY($1::int[]) ORDER BY holder_key`,[holderIds])).rows;
  report.entries = (await client.query(`SELECT e.id,e.holder_key,e.site_id,s.name AS site_name,e.amount::text,e.balance_after::text,e.kind,
      e.description,e.source_table,e.source_id,e.cash_flow_entry_id,e.transfer_id,e.actor_id,e.created_at
    FROM loyalty_vault_entries e LEFT JOIN sites s ON s.id=e.site_id
    WHERE e.holder_type='user' AND e.holder_id=ANY($1::int[]) ORDER BY e.id`,[holderIds])).rows;
  report.tracked_sources = (await client.query(`SELECT v.cash_flow_entry_id,v.holder_key,v.posted_amount::text,v.source_table,v.source_id,
      v.site_id,s.name AS site_name,v.updated_at
    FROM loyalty_vault_sources v LEFT JOIN sites s ON s.id=v.site_id
    WHERE v.holder_key=ANY($1::text[]) ORDER BY v.cash_flow_entry_id`,[report.holders.map(row=>`user:${row.id}`)])).rows;
  report.pending_transfers = (await client.query(`SELECT id,site_id,from_holder_type,from_holder_id,to_holder_id,sender_id,recipient_id,
      amount::text,status,note,created_at FROM loyalty_vault_transfers
    WHERE status='pending' AND (from_holder_type='user' AND from_holder_id=ANY($1::int[]) OR to_holder_id=ANY($1::int[])) ORDER BY created_at`,[holderIds])).rows;
  report.related_transfers = (await client.query(`SELECT t.id,t.site_id,s.name AS site_name,t.from_holder_type,t.from_holder_id,
      giver.name AS from_name,t.to_holder_id,receiver.name AS to_name,t.sender_id,t.recipient_id,t.amount::text,
      t.status,t.note,t.created_at,t.resolved_at,t.resolution_note
    FROM loyalty_vault_transfers t LEFT JOIN sites s ON s.id=t.site_id
    LEFT JOIN users giver ON t.from_holder_type='user' AND giver.id=t.from_holder_id
    LEFT JOIN users receiver ON receiver.id=t.to_holder_id
    WHERE t.from_holder_type='user' AND t.from_holder_id=ANY($1::int[]) OR t.to_holder_id=ANY($1::int[])
    ORDER BY t.created_at`,[holderIds])).rows;
  report.legacy_transfers = (await client.query(`SELECT to_jsonb(t) AS transfer FROM wallet_transfers t
    WHERE sender_id=ANY($1::int[]) OR recipient_id=ANY($1::int[]) ORDER BY created_at`,[holderIds])).rows;
  report.legacy_entries = (await client.query(`SELECT to_jsonb(e) AS entry FROM wallet_entries e
    WHERE user_id=ANY($1::int[]) ORDER BY id`,[holderIds])).rows;
  report.all_site_balances = (await client.query(`SELECT e.holder_key,u.name,e.site_id,s.name AS site_name,
      count(*)::int AS entries,sum(e.amount)::text AS balance
    FROM loyalty_vault_entries e LEFT JOIN users u ON e.holder_type='user' AND u.id=e.holder_id
    LEFT JOIN sites s ON s.id=e.site_id GROUP BY e.holder_key,u.name,e.site_id,s.name ORDER BY e.holder_key,e.site_id`)).rows;
  report.unallocated = (await client.query(`SELECT organization_id,count(*)::int AS entries,sum(amount)::text AS net_amount
    FROM loyalty_vault_entries WHERE site_id IS NULL GROUP BY organization_id ORDER BY organization_id`)).rows;
  report.source_site_mismatches = (await client.query(`SELECT v.cash_flow_entry_id,v.source_table,v.source_id,v.site_id AS tracked_site_id,
      COALESCE(c.site_id,loyalty_vault_source_site('cash_flow_entries',to_jsonb(c))) AS current_cash_site_id
    FROM loyalty_vault_sources v JOIN cash_flow_entries c ON c.id=v.cash_flow_entry_id
    WHERE v.site_id IS DISTINCT FROM COALESCE(c.site_id,loyalty_vault_source_site('cash_flow_entries',to_jsonb(c)))
    ORDER BY v.cash_flow_entry_id LIMIT 100`)).rows;
  await client.query('COMMIT');
  if (process.argv[2]) await writeFile(process.argv[2],`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify(report,null,2));
} catch (error) {
  if (client) await client.query('ROLLBACK');
  console.error(JSON.stringify({error:error.code || error.name,message:error.message}));
  process.exitCode=1;
} finally {
  client?.release();
  await pool.end();
}
