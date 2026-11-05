import {historyOrderIndexSql} from '../../src/migrations/236_history_keyset_order.js';
export async function installFixtureHistoryOrderIndexes(db,tables) {
  const {rows}=await db.query(`SELECT table_name,column_name,data_type,udt_name,current_setting('TimeZone') AS history_timezone
    FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`,[tables]);
  for(const table of tables){
    const columns=new Map(rows.filter(row=>row.table_name===table).map(row=>[row.column_name,row]));
    await db.query(historyOrderIndexSql(table,columns,`fixture_order_${table}`,{concurrently:false}));
    await db.query(`DROP INDEX IF EXISTS archive_${table}`);
    await db.query(`ANALYZE ${table}`);
  }
}
