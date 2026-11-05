import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { postingPolicySql } from '../../src/migrations/171_cheque_clearance_before_approval.js';
import { up } from '../../src/migrations/237_cashflow_money_transfers.js';

// Isolated accounting contract fixture. No configured application database is
// accessed here. Production column types/checks come from the existing fixture.
export async function installCashflowFixture(db) {
  await db.query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
    INSERT INTO users VALUES (1,'Admin','admin',1,true),(2,'Staff','sub_admin',1,true),
      (3,'Scoped staff','sub_admin',1,true),(4,'Outside admin','admin',2,true),
      (5,'Inactive','admin',1,false),(6,'Read only','sub_admin',1,true),(7,'Own entries','sub_admin',1,true);
    CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
    INSERT INTO sites VALUES(10,'Source site',1),(11,'Destination site',1),(20,'Outside organization',2);
    CREATE TABLE user_sites(user_id integer,site_id integer,PRIMARY KEY(user_id,site_id));
    INSERT INTO user_sites VALUES(2,10),(2,11),(3,10),(6,10),(7,10);
    CREATE TABLE user_permissions(user_id integer,module text,can_read boolean,can_write boolean,can_view_all boolean);
    INSERT INTO user_permissions VALUES(2,'cashflow',true,true,true),(3,'cashflow',true,true,true),
      (6,'cashflow',true,false,true),(7,'cashflow',true,true,false);
    CREATE TABLE application_settings(id serial PRIMARY KEY,site_id integer,setting_key text NOT NULL,setting_value jsonb,updated_by integer,updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX application_settings_global_key_idx ON application_settings(setting_key) WHERE site_id IS NULL;
    CREATE TABLE transaction_money_transfers(id uuid PRIMARY KEY,source_type text,source_record_id integer);
    CREATE TABLE plot_money_transfers(id uuid PRIMARY KEY,source_payment_id integer);`);
  const full = await readFile(new URL('./transaction-transfer-schema.sql', import.meta.url), 'utf8');
  await db.query(full.slice(full.indexOf('CREATE TABLE cash_flow_entries'), full.indexOf('CREATE TABLE day_book')));
  await db.query(`ALTER TABLE cash_flow_entries ADD COLUMN entry_transfer_id uuid, ADD COLUMN reversed_at timestamptz, ADD COLUMN is_reversed boolean DEFAULT false;
    ALTER TABLE cash_flow_entries ADD FOREIGN KEY(cash_flow_month_id) REFERENCES cash_flow_months(id) ON DELETE CASCADE;
    ${postingPolicySql};
    CREATE VIEW ledger_entries AS SELECT e.id::text,e.site_id,e.cash_flow_month_id,e.date AS entry_date,
      CASE WHEN financial_transaction_posts('debit',e.status,e.cash_type,e.cheque_status) THEN e.debit ELSE 0 END AS debit,
      CASE WHEN financial_transaction_posts('credit',e.status,e.cash_type,e.cheque_status) THEN e.credit ELSE 0 END AS credit,
      CASE WHEN e.cash_type='cash' THEN 'cash' ELSE 'bank' END AS bucket,
      COALESCE(e.source_module,'personal_ledger') AS source_key
      FROM cash_flow_entries e WHERE COALESCE(e.source_module,'')!~'_person$'
      AND COALESCE(e.source_module,'') NOT IN('plot_registry_payments','imprest','plot_commissions');`);
  await db.query(`CREATE TABLE test_site_reservations(site_id integer PRIMARY KEY,amount numeric(15,2) NOT NULL DEFAULT 0);
    CREATE FUNCTION imprest_available_site_cash(p_site integer) RETURNS numeric LANGUAGE sql AS $$
      SELECT COALESCE((SELECT sum(credit-debit) FROM ledger_entries WHERE site_id=p_site AND bucket='cash'),0)
        - COALESCE((SELECT amount FROM test_site_reservations WHERE site_id=p_site),0) $$;`);
  await up(db);
}

export async function fixtureLedger(db, { site=10, name=`Ledger ${randomUUID()}`, month=11, year=2026, opening='0.00', locked=false }={}) {
  return (await db.query(`INSERT INTO cash_flow_months(site_id,month,year,ledger_name,ledger_type,opening_balance,is_locked,created_by)
    VALUES($1,$2,$3,$4,'person',$5,$6,1) RETURNING *`,[site,month,year,name,opening,locked])).rows[0];
}
export async function fixtureEntry(db,ledger,{credit='100.00',debit='0.00',mode='cash',status='approved',source=null,sourceId=null,cheque=null,extra={}}={}) {
  const row=(await db.query(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,particular,credit,debit,cash_type,status,source_module,source_id,cheque_status,created_by)
    VALUES($1,$2,'Isolated test receipt',$3,$4,$5,$6,$7,$8,$9,1) RETURNING *`,[ledger.id,ledger.site_id,credit,debit,mode,status,source,sourceId,cheque])).rows[0];
  const allowed=['entry_transfer_id','reversed_at','is_reversed','date'];
  for(const [key,value] of Object.entries(extra)) {
    if(!allowed.includes(key)) throw Error('Unknown fixture override');
    await db.query(`UPDATE cash_flow_entries SET ${key}=$2 WHERE id=$1`,[row.id,value]);
  }
  return row;
}
export async function fixturePair(db,{site=10,credits=['100.00'],modes=[],opening='0.00'}={}) {
  const source=await fixtureLedger(db,{opening}),destination=await fixtureLedger(db,{site});
  const entries=[];
  for(let index=0;index<credits.length;index++) entries.push(await fixtureEntry(db,source,{credit:credits[index],mode:modes[index]||'cash'}));
  return {source,destination,entries,request:{source_ledger_id:source.id,destination_ledger_id:destination.id,
    source_transaction_ids:entries.map(row=>row.id),idempotency_key:randomUUID()}};
}
export async function ledgerFunds(db,id) {
  return (await db.query(`SELECT (m.opening_balance+COALESCE(sum(l.credit-l.debit),0))::numeric(15,2)::text AS balance
    FROM cash_flow_months m LEFT JOIN ledger_entries l ON l.cash_flow_month_id=m.id WHERE m.id=$1 GROUP BY m.id`,[id])).rows[0].balance;
}
export async function organizationFunds(db) {
  return (await db.query(`SELECT COALESCE(sum(l.credit-l.debit),0)::numeric(15,2)::text AS balance
    FROM ledger_entries l JOIN sites s ON s.id=l.site_id WHERE s.organization_id=1`)).rows[0].balance;
}
export async function siteFunds(db,id) {
  return (await db.query('SELECT COALESCE(sum(credit-debit),0)::numeric(15,2)::text AS balance FROM ledger_entries WHERE site_id=$1',[id])).rows[0].balance;
}

export async function pgliteFixture() {
  const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
  const pg=new PGlite();
  const query=async(sql,args)=>{
    const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);
    return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};
  };
  // Serializing transactions is necessary on PGlite's single connection.
  // This proves retry behavior, NOT independent PostgreSQL lock timing.
  let queue=Promise.resolve();
  const db={query,connect:async()=>{
    const previous=queue;let release;queue=new Promise(resolve=>{release=resolve;});
    await previous;return {query,release};
  }};
  await installCashflowFixture(db);
  return {db,close:()=>pg.close()};
}
