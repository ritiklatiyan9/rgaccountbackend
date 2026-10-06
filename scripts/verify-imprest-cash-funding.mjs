import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { getSiteBalanceDetail } from '../src/graphql/services/kpi.service.js';

const db = await pool.connect();
const evidence = { checked_at: new Date().toISOString(), protections: [], sites: [] };
try {
  await db.query('BEGIN READ ONLY');
  const { rows: triggers } = await db.query(`SELECT tgname AS name,tgenabled AS enabled,relname AS table
    FROM pg_trigger JOIN pg_class ON pg_class.oid=tgrelid
    WHERE tgname IN ('imprest_allocation_cash_guard','imprest_manual_credit_cash_guard','imprest_transfer_cash_guard','imprest_refill_request_cash_guard')
    ORDER BY tgname`);
  assert.equal(triggers.length,4);
  assert.ok(triggers.every(t=>t.enabled==='O'));
  evidence.protections=triggers;
  const { rows: [date] } = await db.query("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS cutoff");
  const { rows: sites } = await db.query('SELECT id,name FROM sites ORDER BY id');
  for(const site of sites) {
    const detail=await getSiteBalanceDetail(site.id,'1900-01-01',date.cutoff,db);
    const {rows:[guard]}=await db.query('SELECT imprest_available_site_cash($1) AS available',[site.id]);
    assert.equal(Number(guard.available),detail.distributableBalance,'DB and application cash must agree');
    evidence.sites.push({...site,cash:detail.cashBalance,staff:detail.imprestHeld,pending:detail.pendingImprestReservations,available:Number(guard.available)});
  }
  const {rows:refund}=await db.query('SELECT id,site_id,user_id,type,amount,reference_id,source_module,created_at,remarks FROM imprest_ledger WHERE id IN (865,866) ORDER BY id');
  const {rows:legacy}=await db.query(`SELECT id,site_id,user_id,type,amount,reference_id,source_module,remarks FROM imprest_ledger
    WHERE site_id IN (1,7) AND (type='ALLOCATION' OR amount>0) ORDER BY site_id,id`);
  evidence.sga_refund_postings=refund;
  evidence.legacy_funding_postings=legacy;
  await db.query('COMMIT');
  for(const site of evidence.sites.filter(s=>s.available<=0)) {
    await db.query('BEGIN READ ONLY');
    try {
      await db.query('SELECT require_imprest_site_cash($1,1)',[site.id]);
      throw Error(`Site ${site.id} incorrectly allowed new funding`);
    } catch(error) {
      assert.equal(error.constraint,'imprest_site_cash_funding');
      site.one_rupee_distribution_blocked=true;
    } finally { await db.query('ROLLBACK'); }
  }
  await writeFile('../reports/imprest-cash-guard-verification-2026-10-06.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally { db.release(); await pool.end(); }
