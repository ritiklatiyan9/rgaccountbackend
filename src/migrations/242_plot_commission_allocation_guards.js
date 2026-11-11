import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { allocationIntegritySql, allocationMetadataConstraintSql } from './241_plot_commission_allocations.js';
export const VERSION='242_plot_commission_allocation_guards_v3';
export async function up(database=pool) {
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('242_plot_commission_allocation_guards_v3'))");
    if ((await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length) { await db.query('COMMIT'); return false; }
    await db.query(allocationMetadataConstraintSql);
    await db.query(allocationIntegritySql);
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1)',[VERSION]);
    await db.query('COMMIT');return true;
  } catch(error) { await db.query('ROLLBACK');throw error; }
  finally { db.release(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(applied=>console.log(applied?'Dealer commission guards updated; existing amounts preserved':'Dealer commission guards already current'))
    .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
