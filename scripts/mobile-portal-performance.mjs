import pool from '../src/config/db.js';
const phone=`CASE WHEN length(regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g'))=10 THEN regexp_replace(m.phone,'[^0-9]','','g') WHEN regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g') ~ '^0[6-9][0-9]{9}$' THEN right(regexp_replace(m.phone,'[^0-9]','','g'),10) WHEN regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g') ~ '^(0091|91)[6-9][0-9]{9}$' THEN right(regexp_replace(m.phone,'[^0-9]','','g'),10) ELSE '' END`;
const base=`SELECT m.id FROM members m JOIN sites s ON s.id=m.site_id WHERE 'CLIENT'=ANY(COALESCE(m.member_types,ARRAY[m.member_type])) AND COALESCE(to_jsonb(m)->>'is_active','true') <> 'false'`;
// EXPLAIN ANALYZE performs SELECTs only. It reports aggregate plan/timing data,
// never customer values or credentials, and uses an impossible phone candidate.
const output=[];
for(const [name,sql,args] of [
 ['phone_before',`${base} AND ${phone}=$1 ORDER BY m.id LIMIT 1001`,['synthetic-no-match']],
 ['phone_after',`${base} AND right(regexp_replace(COALESCE(m.phone,''),'[^0-9]','','g'),10)=$1 AND ${phone}=$1 ORDER BY m.id LIMIT 1001`,['synthetic-no-match']],
 ['booking_latest',`SELECT b.client_member_id FROM bookings b JOIN members m ON m.id=b.client_member_id AND m.site_id=b.site_id WHERE b.plot_id=$1 AND b.site_id=$2 AND lower(COALESCE(b.status,'')) NOT LIKE 'cancel%' ORDER BY b.id DESC LIMIT 1`,[0,0]],
]){
 const {rows}=await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,args);
 const p=rows[0]['QUERY PLAN'][0];const nodes=[];
 const walk=n=>{nodes.push({type:n['Node Type'],index:n['Index Name'],rows:n['Actual Rows'],loops:n['Actual Loops']});for(const c of n.Plans||[])walk(c);};walk(p.Plan);
 output.push({name,executionMs:p['Execution Time'],planningMs:p['Planning Time'],nodes});
}
console.log(JSON.stringify(output));await pool.end();
