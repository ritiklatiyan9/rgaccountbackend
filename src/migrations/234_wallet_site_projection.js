import {pathToFileURL} from 'node:url';
import pool from '../config/db.js';

export const VERSION='234_wallet_site_projection';
export const walletSiteProjectionExpectedSql=`SELECT e.organization_id,e.site_id,e.holder_key,
 min(e.holder_type) AS holder_type,min(e.holder_id) AS holder_id,
 sum(e.amount) AS balance,
 COALESCE(sum(e.amount) FILTER(WHERE e.kind NOT IN ('transfer_out','imprest_out')),0) AS total_in,
 COALESCE(sum(e.amount) FILTER(WHERE e.kind NOT IN ('transfer_out','imprest_out','adjustment')),0) AS total_received,
 -COALESCE(sum(e.amount) FILTER(WHERE e.kind='transfer_out'),0) AS total_handover,
 -COALESCE(sum(e.amount) FILTER(WHERE e.kind='imprest_out'),0) AS total_imprest_out,
 COALESCE(sum(e.amount) FILTER(WHERE e.kind='transfer_in'),0) AS total_transfer_in,
 COALESCE(sum(e.amount) FILTER(WHERE e.kind='adjustment'),0) AS total_adjustments,
 count(*)::bigint AS entry_count,max(e.created_at) AS updated_at,max(e.id)::bigint AS last_entry_id,
 max(e.id) FILTER(WHERE e.source_table='manual_wallet_site_cash_alignment')::bigint AS aligned_id
 FROM loyalty_vault_entries e WHERE e.site_id IS NOT NULL
 GROUP BY e.organization_id,e.site_id,e.holder_key`;
export const walletSiteProjectionReconciliationSql=`WITH expected AS (${walletSiteProjectionExpectedSql}), differences AS (
 SELECT COALESCE(e.organization_id,p.organization_id) AS organization_id,COALESCE(e.site_id,p.site_id) AS site_id,
  COALESCE(e.holder_key,p.holder_key) AS holder_key FROM expected e FULL OUTER JOIN loyalty_vault_site_accounts p
  USING(organization_id,site_id,holder_key)
 WHERE ROW(e.holder_type,e.holder_id,e.balance,e.total_in,e.total_received,e.total_handover,e.total_imprest_out,
   e.total_transfer_in,e.total_adjustments,e.entry_count,e.updated_at,e.last_entry_id,e.aligned_id)
 IS DISTINCT FROM ROW(p.holder_type,p.holder_id,p.balance,p.total_in,p.total_received,p.total_handover,p.total_imprest_out,
   p.total_transfer_in,p.total_adjustments,p.entry_count,p.updated_at,p.last_entry_id,p.aligned_id)
) SELECT count(*)::integer AS mismatches,
 (SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM (SELECT * FROM differences ORDER BY organization_id,site_id,holder_key LIMIT 20)x) AS examples
 FROM differences`;

export const walletSiteProjectionSql=`CREATE TABLE IF NOT EXISTS loyalty_vault_site_accounts(
 organization_id integer NOT NULL,site_id integer NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
 holder_key text NOT NULL,holder_type text NOT NULL CHECK(holder_type IN ('user','member')),holder_id integer NOT NULL CHECK(holder_id>0),
 balance numeric NOT NULL DEFAULT 0,total_in numeric NOT NULL DEFAULT 0,total_received numeric NOT NULL DEFAULT 0,
 total_handover numeric NOT NULL DEFAULT 0,total_imprest_out numeric NOT NULL DEFAULT 0,total_transfer_in numeric NOT NULL DEFAULT 0,total_adjustments numeric NOT NULL DEFAULT 0,
 entry_count bigint NOT NULL DEFAULT 0 CHECK(entry_count>=0),updated_at timestamptz,last_entry_id bigint NOT NULL,
 aligned_id bigint,PRIMARY KEY(organization_id,site_id,holder_key),
 CONSTRAINT wallet_site_projection_holder CHECK(holder_key=holder_type||':'||holder_id::text)
);
CREATE INDEX IF NOT EXISTS wallet_site_projection_holder ON loyalty_vault_site_accounts(organization_id,holder_key,site_id);
CREATE OR REPLACE FUNCTION capture_wallet_site_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.site_id IS NULL THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM sites WHERE id=NEW.site_id AND organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Wallet entry organization and site differ' USING ERRCODE='23514',CONSTRAINT='wallet_site_projection_scope';
 END IF;
 INSERT INTO loyalty_vault_site_accounts AS p(organization_id,site_id,holder_key,holder_type,holder_id,
  balance,total_in,total_received,total_handover,total_imprest_out,total_transfer_in,total_adjustments,entry_count,updated_at,last_entry_id,aligned_id)
 VALUES(NEW.organization_id,NEW.site_id,NEW.holder_key,NEW.holder_type,NEW.holder_id,
  NEW.amount,CASE WHEN NEW.kind NOT IN ('transfer_out','imprest_out') THEN NEW.amount ELSE 0 END,
  CASE WHEN NEW.kind NOT IN ('transfer_out','imprest_out','adjustment') THEN NEW.amount ELSE 0 END,
  CASE WHEN NEW.kind='transfer_out' THEN -NEW.amount ELSE 0 END,
  CASE WHEN NEW.kind='imprest_out' THEN -NEW.amount ELSE 0 END,
  CASE WHEN NEW.kind='transfer_in' THEN NEW.amount ELSE 0 END,
  CASE WHEN NEW.kind='adjustment' THEN NEW.amount ELSE 0 END,1,NEW.created_at,NEW.id,
  CASE WHEN NEW.source_table='manual_wallet_site_cash_alignment' THEN NEW.id ELSE NULL END)
 ON CONFLICT(organization_id,site_id,holder_key) DO UPDATE SET
  balance=p.balance+EXCLUDED.balance,total_in=p.total_in+EXCLUDED.total_in,total_received=p.total_received+EXCLUDED.total_received,
  total_handover=p.total_handover+EXCLUDED.total_handover,total_imprest_out=p.total_imprest_out+EXCLUDED.total_imprest_out,
  total_transfer_in=p.total_transfer_in+EXCLUDED.total_transfer_in,total_adjustments=p.total_adjustments+EXCLUDED.total_adjustments,entry_count=p.entry_count+1,
  updated_at=GREATEST(p.updated_at,EXCLUDED.updated_at),last_entry_id=GREATEST(p.last_entry_id,EXCLUDED.last_entry_id),
  aligned_id=GREATEST(p.aligned_id,EXCLUDED.aligned_id);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wallet_site_projection_capture ON loyalty_vault_entries;
CREATE TRIGGER wallet_site_projection_capture AFTER INSERT ON loyalty_vault_entries FOR EACH ROW EXECUTE FUNCTION capture_wallet_site_projection();`;

export async function verifyWalletSiteProjection(db){
 const result=(await db.query(walletSiteProjectionReconciliationSql)).rows[0];
 if(Number(result.mismatches)!==0)throw Object.assign(new Error('Wallet site projection does not reconcile with immutable postings'),{code:'WALLET_PROJECTION_MISMATCH',details:result});
 return result;
}
async function ledgerFingerprint(db){
 return (await db.query(`SELECT count(*)::text AS count,COALESCE(sum(amount),0)::text AS amount,
  md5(COALESCE(string_agg(md5(to_jsonb(e)::text),'' ORDER BY id),'')) AS hash FROM loyalty_vault_entries e`)).rows[0];
}
async function projectionFingerprints(db){
 return (await db.query(`WITH expected AS (${walletSiteProjectionExpectedSql}), fingerprints AS (
  SELECT 'expected'::text AS kind,count(*)::text AS count,COALESCE(sum(balance),0)::text AS balance,
   md5(COALESCE(string_agg(md5(to_jsonb(e)::text),'' ORDER BY organization_id,site_id,holder_key),'')) AS hash FROM expected e
  UNION ALL
  SELECT 'projected',count(*)::text,COALESCE(sum(balance),0)::text,
   md5(COALESCE(string_agg(md5(to_jsonb(p)::text),'' ORDER BY organization_id,site_id,holder_key),'')) FROM loyalty_vault_site_accounts p
 ) SELECT * FROM fingerprints ORDER BY kind`)).rows;
}
export async function up(database=pool){
 const db=await database.connect();
 try{
  // READ COMMITTED is intentional: after waiting for active writers, the
  // backfill must include every commit preceding acquisition of the table lock.
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('234_wallet_site_projection'))");
  const installed=(await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length>0;
  if(installed){await db.query('COMMIT');return {applied:false};}
  // This conflicts with INSERT. Trigger installation, backfill and full-vector
  // verification commit together; no financial arrival can be lost or counted twice.
  await db.query('LOCK TABLE loyalty_vault_entries IN SHARE ROW EXCLUSIVE MODE');
  const sourceBefore=await ledgerFingerprint(db);
  const invalid=(await db.query(`SELECT count(*)::integer AS count FROM loyalty_vault_entries e LEFT JOIN sites s ON s.id=e.site_id
   WHERE e.site_id IS NOT NULL AND (s.id IS NULL OR s.organization_id IS DISTINCT FROM e.organization_id
    OR e.holder_key IS DISTINCT FROM e.holder_type||':'||e.holder_id::text)`)).rows[0].count;
  if(Number(invalid))throw Error('Existing wallet entries have an invalid site or holder scope; review before installing the projection');
  await db.query(walletSiteProjectionSql);
  await db.query('LOCK TABLE loyalty_vault_site_accounts IN SHARE ROW EXCLUSIVE MODE');
  await db.query(`INSERT INTO loyalty_vault_site_accounts(organization_id,site_id,holder_key,holder_type,holder_id,balance,total_in,total_received,
   total_handover,total_imprest_out,total_transfer_in,total_adjustments,entry_count,updated_at,last_entry_id,aligned_id)
   ${walletSiteProjectionExpectedSql} ON CONFLICT(organization_id,site_id,holder_key) DO UPDATE SET
   holder_type=EXCLUDED.holder_type,holder_id=EXCLUDED.holder_id,balance=EXCLUDED.balance,total_in=EXCLUDED.total_in,
   total_received=EXCLUDED.total_received,total_handover=EXCLUDED.total_handover,total_imprest_out=EXCLUDED.total_imprest_out,total_transfer_in=EXCLUDED.total_transfer_in,
   total_adjustments=EXCLUDED.total_adjustments,entry_count=EXCLUDED.entry_count,updated_at=EXCLUDED.updated_at,
   last_entry_id=EXCLUDED.last_entry_id,aligned_id=EXCLUDED.aligned_id`);
  const verification=await verifyWalletSiteProjection(db);
  const fingerprints=await projectionFingerprints(db),sourceAfter=await ledgerFingerprint(db);
  if(JSON.stringify(sourceBefore)!==JSON.stringify(sourceAfter))throw Error('Immutable wallet postings changed during projection installation');
  if(fingerprints[0].count!==fingerprints[1].count||fingerprints[0].balance!==fingerprints[1].balance||fingerprints[0].hash!==fingerprints[1].hash)
   throw Error('Wallet projection fingerprint verification failed');
  const counts=(await db.query('SELECT count(*)::text AS accounts,COALESCE(sum(entry_count),0)::text AS entries FROM loyalty_vault_site_accounts')).rows[0];
  await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[VERSION]);
  await db.query('COMMIT');return {applied:true,verification,...counts,source_before:sourceBefore,source_after:sourceAfter,projection_fingerprints:fingerprints};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
export async function down(database=pool){
 const db=await database.connect();
 try{
  await db.query("BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('234_wallet_site_projection'))");
  await db.query('LOCK TABLE loyalty_vault_entries IN SHARE ROW EXCLUSIVE MODE');
  await db.query('DROP TRIGGER IF EXISTS wallet_site_projection_capture ON loyalty_vault_entries');
  await db.query('DROP FUNCTION IF EXISTS capture_wallet_site_projection()');
  await db.query('DROP TABLE IF EXISTS loyalty_vault_site_accounts');
  await db.query('DELETE FROM app_schema_migrations WHERE version=$1',[VERSION]);await db.query('COMMIT');
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 (process.argv.includes('--down')?down():up()).then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
