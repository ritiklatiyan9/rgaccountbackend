import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { loadClientDemographics, CLIENT_DEMOGRAPHICS_SQL, CLIENT_DEMOGRAPHICS_SCOPE } from '../src/services/clientDemographicsRead.service.js';

const sort = rows => [...rows].sort((a, b) => a.label.localeCompare(b.label));
test('batched client demographics preserve filters, normalization, counts, age bands and limits', async t => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE members(id int, site_id int, member_type text, status text,
      occupation text, city text, state text, gender text, date_of_birth date, qualification text, team text);
      INSERT INTO members VALUES
        (1,1,'CLIENT','active',' engineer ','Delhi','UP','Male',CURRENT_DATE - INTERVAL '25 years','Graduate','A'),
        (2,1,'client',NULL,'ENGINEER',' delhi ','UP','Female',CURRENT_DATE - INTERVAL '35 years','Graduate','A'),
        (3,1,'CLIENT','active',NULL,'','   ',NULL,NULL,NULL,NULL),
        (4,1,'CLIENT','active','Teacher','Agra','UP','Male',CURRENT_DATE - INTERVAL '45 years','Masters','B'),
        (5,1,'CLIENT','active','Teacher','Agra','UP','Male',CURRENT_DATE - INTERVAL '55 years','Masters','B'),
        (6,1,'CLIENT','active','Teacher','Agra','UP','Male',CURRENT_DATE - INTERVAL '65 years','Masters','B'),
        (7,1,'CLIENT','deleted','hidden','Hidden','Hidden','Hidden',CURRENT_DATE,'Hidden','Hidden'),
        (8,2,'CLIENT','active','other site','Other','Other','Other',CURRENT_DATE,'Other','Other'),
        (9,1,'AGENT','active','other type','Other','Other','Other',CURRENT_DATE,'Other','Other');`);
    let count = 0;
    const measured = { query: (...args) => { count++; return db.query(...args); } };
    const result = await loadClientDemographics(1, measured);
    assert.equal(count, 1);
    const age = `CASE WHEN m.date_of_birth IS NULL THEN NULL
      WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 30 THEN 'Under 30'
      WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 40 THEN '30-39'
      WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 50 THEN '40-49'
      WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 60 THEN '50-59' ELSE '60+' END`;
    for (const [key, expr, limit] of [
      ['occupation', 'm.occupation', 12], ['city', 'm.city', 12], ['state', 'm.state', 8],
      ['gender', 'm.gender', 6], ['age', age, 8], ['qualification', 'm.qualification', 8], ['team', 'm.team', 12],
    ]) await t.test(key, async () => {
      const { rows } = await db.query(`SELECT COALESCE(NULLIF(UPPER(TRIM(${expr})), ''), 'UNSPECIFIED') AS label,
        COUNT(*)::int AS count FROM members m WHERE ${CLIENT_DEMOGRAPHICS_SCOPE}
        GROUP BY 1 ORDER BY 2 DESC LIMIT $2`, [1, limit]);
      assert.deepEqual(sort(result[key]), sort(rows));
      assert.equal(result[key].reduce((sum, row) => sum + row.count, 0), 6);
    });
    assert.deepEqual(await loadClientDemographics(3, db), Object.fromEntries(Object.keys(result).map(key => [key, []])));
    await t.test('plan scans members once for seven dimension groups', async () => {
      const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${CLIENT_DEMOGRAPHICS_SQL}`, [1]);
      const scans = [];
      const walk = node => { if (node['Relation Name'] === 'members') scans.push(node); (node.Plans || []).forEach(walk); };
      walk(rows[0]['QUERY PLAN'][0].Plan);
      assert.equal(scans.length, 1);
      assert.equal(scans[0]['Actual Loops'], 1);
    });
    await t.test('per-dimension limits remain independent', async () => {
      await db.exec(`INSERT INTO members
        SELECT 1000 + n, 4, 'CLIENT', 'active', 'JOB' || n, 'CITY' || n, 'STATE' || n,
          'GENDER' || n, CURRENT_DATE - INTERVAL '25 years', 'QUAL' || n, 'TEAM' || n
        FROM generate_series(1,20) n;`);
      const limited = await loadClientDemographics(4, db);
      assert.equal(limited.occupation.length, 12);
      assert.equal(limited.city.length, 12);
      assert.equal(limited.state.length, 8);
      assert.equal(limited.gender.length, 6);
      assert.equal(limited.qualification.length, 8);
      assert.equal(limited.team.length, 12);
    });
  } finally { await db.close(); }
});
