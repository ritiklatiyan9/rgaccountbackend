// Read-only diagnostic. Compile and execute the complete history query through
// EXPLAIN; print timings and plan counts, never request contents or identities.
import pool from '../../src/config/db.js';
import { listRequestHistory } from '../../src/controllers/approval.controller.js';

const client = await pool.connect();
const originalQuery = pool.query;
let statements = 0, report;
try {
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='15s'");
  const { rows: [site] } = await client.query(`SELECT s.id,s.organization_id FROM sites s LEFT JOIN expenses e ON e.site_id=s.id
    GROUP BY s.id ORDER BY count(e.id) DESC,s.id LIMIT 1`);
  if (!site) throw new Error('No site is available to validate the plan');
  pool.query = async (input, params) => {
    const sql=typeof input==='string'?input:input.text,values=typeof input==='string'?params:input.values;
    statements++;
    if (!sql.startsWith('WITH source_')) return client.query(sql, values);
    let rows;
    try { ({ rows } = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, values)); }
    catch(error) {
      // Generated SQL contains only code and placeholders, never parameter values.
      const at=Number(error.position)-'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '.length-1;
      console.error('History SQL context:',sql.slice(Math.max(0,at-130),at+130));
      throw error;
    }
    const plan = rows[0]['QUERY PLAN'][0];
    const nodes = [];
    const visit = node => { nodes.push(node); (node.Plans || []).forEach(visit); };
    visit(plan.Plan);
    report = { sources: (sql.match(/source_\d+ AS NOT MATERIALIZED/g) || []).length,
      execution_ms: plan['Execution Time'], planning_ms: plan['Planning Time'],
      page_rows: nodes.find(node => node['Subplan Name'] === 'CTE page')?.['Actual Rows'],
      index_scans: nodes.filter(node => /Index.*Scan/.test(node['Node Type'])).length };
    return { rows: [{ total: 0, entries: [] }] };
  };
  // An internal planning context, not a login or a grant. The read-only
  // transaction returns only an EXPLAIN plan; no request rows are fetched.
  await new Promise((resolve, reject) => listRequestHistory({ user: { id: 0, role: 'admin', organization_id: site.organization_id },
    query: { site_id: String(site.id), page_size: '20', ...(process.env.HISTORY_PLAN_MODE==='cursor'
      ? {pagination:'cursor',view:'summary',include_total:'false'} : {}) } }, {
    set() { return this; }, status(code) { reject(new Error(`Plan request failed (${code})`)); return this; }, json() { resolve(); },
  }, reject));
  if (!report) throw new Error('History did not produce a database plan');
  console.log(JSON.stringify({ ...report, diagnostic_statements: statements }, null, 2));
} finally {
  pool.query = originalQuery;
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
