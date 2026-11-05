import 'dotenv/config';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {installCashflowFixture} from './cashflow-money-transfers.mjs';

// Opt-in integration runner. Every query uses an exclusive disposable schema;
// public is deliberately absent from search_path, including fixture functions.
export async function isolatedPostgresFixture({install=true}={}) {
  if(process.env.CASHFLOW_PG_TEST!=='1') throw Error('Set CASHFLOW_PG_TEST=1 to run isolated PostgreSQL integration checks.');
  const schema=`cf_transfer_test_${process.pid}_${randomBytes(5).toString('hex')}`;
  if(!/^cf_transfer_test_\d+_[a-f0-9]{10}$/.test(schema)) throw Error('Unsafe test namespace');
  // Neon transaction poolers reject search_path startup options. The direct
  // endpoint pins each test connection and preserves the isolation guarantee.
  const host=process.env.CASHFLOW_PG_TEST_HOST||process.env.DB_HOST?.replace('-pooler.','.');
  const config={host,port:Number(process.env.DB_PORT||5432),database:process.env.DB_NAME,
    user:process.env.DB_USER,password:process.env.DB_PASSWORD,
    ssl:process.env.DB_SSL==='true'||process.env.DB_HOST?.includes('neon')?{rejectUnauthorized:false}:false,
    max:12,connectionTimeoutMillis:10000,application_name:`cashflow-isolated-test-${process.pid}`};
  const bootstrap=new pg.Pool({...config,max:1});
  let db,connections;
  try {
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    connections=new pg.Pool({...config,options:`-c search_path=${schema},pg_catalog`});
    // Advisory locks live at database scope, not schema scope. Salt their fixed
    // namespace strings in service SQL AND installed trigger definitions so
    // test workers retain the same locking relationships without ever holding
    // a production site's mutex or another isolated test's mutex.
    const isolatedSql=sql=>typeof sql==='string'?sql.replace(/hashtext\('([^']+)'/g,(_match,key)=>`hashtext('${schema}:${key}'`):sql;
    db={query:(sql,args)=>connections.query(isolatedSql(sql),args),connect:async()=>{
      const client=await connections.connect();
      return {query:(sql,args)=>client.query(isolatedSql(sql),args),release:error=>client.release(error),
        on:client.on.bind(client),removeListener:client.removeListener.bind(client)};
    }};
    const result=await db.query('SELECT current_schema() AS schema,current_schemas(false) AS scopes');
    if(result.rows[0].schema!==schema||result.rows[0].scopes.includes('public')) throw Error('Isolated search_path verification failed');
    if(install) {
      await installCashflowFixture(db);
      const definition=(await db.query("SELECT pg_get_functiondef(to_regprocedure('lock_cashflow_money_balance()')) AS sql")).rows[0]?.sql;
      if(!definition?.includes(`${schema}:imprest-site-`)) throw Error('Fixture advisory-lock namespace isolation failed');
    }
  } catch(error) {
    await connections?.end();await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await bootstrap.end();throw error;
  }
  return {db,schema,close:async()=>{
    await connections.end();await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);await bootstrap.end();
  }};
}
