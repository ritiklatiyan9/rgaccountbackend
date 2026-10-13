export const CLIENT_DEMOGRAPHICS_SCOPE = `m.site_id = $1 AND UPPER(COALESCE(m.member_type, '')) = 'CLIENT' AND LOWER(COALESCE(m.status, 'active')) <> 'deleted'`;

const DIMENSIONS = Object.freeze([
  { key: 'occupation', expr: 'm.occupation', limit: 12 },
  { key: 'city', expr: 'm.city', limit: 12 },
  { key: 'state', expr: 'm.state', limit: 8 },
  { key: 'gender', expr: 'm.gender', limit: 6 },
  { key: 'age', expr: `CASE WHEN m.date_of_birth IS NULL THEN NULL
    WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 30 THEN 'Under 30'
    WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 40 THEN '30-39'
    WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 50 THEN '40-49'
    WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 60 THEN '50-59' ELSE '60+' END`, limit: 8 },
  { key: 'qualification', expr: 'm.qualification', limit: 8 },
  { key: 'team', expr: 'm.team', limit: 12 },
]);

const keys = DIMENSIONS.map(dimension => dimension.key).join(', ');
const allBits = 2 ** DIMENSIONS.length - 1;
// GROUPING SETS aggregates every dimension over a single pass of the site's
// clients. This replaces seven concurrently submitted scans of members.
export const CLIENT_DEMOGRAPHICS_SQL = `WITH client_values AS (
  SELECT ${DIMENSIONS.map(({ key, expr }) => `COALESCE(NULLIF(UPPER(TRIM(${expr})), ''), 'UNSPECIFIED') AS ${key}`).join(',\n         ')}
  FROM members m WHERE ${CLIENT_DEMOGRAPHICS_SCOPE}
), grouped AS (
  SELECT ${keys}, GROUPING(${keys}) AS grouping, COUNT(*)::int AS count
  FROM client_values
  GROUP BY GROUPING SETS (${DIMENSIONS.map(({ key }) => `(${key})`).join(', ')})
), ranked AS (
  SELECT CASE grouping ${DIMENSIONS.map(({ key }, index) => `WHEN ${allBits - 2 ** (DIMENSIONS.length - index - 1)} THEN '${key}'`).join(' ')} END AS dimension,
    COALESCE(${keys}) AS label, count,
    ROW_NUMBER() OVER (PARTITION BY grouping ORDER BY count DESC) AS position
  FROM grouped
)
SELECT dimension, label, count FROM ranked
WHERE position <= CASE dimension ${DIMENSIONS.map(({ key, limit }) => `WHEN '${key}' THEN ${limit}`).join(' ')} END
ORDER BY dimension, position`;

export async function loadClientDemographics(siteId, db) {
  const { rows } = await db.query(CLIENT_DEMOGRAPHICS_SQL, [siteId]);
  const demographics = Object.fromEntries(DIMENSIONS.map(({ key }) => [key, []]));
  for (const { dimension, label, count } of rows) demographics[dimension].push({ label, count });
  return demographics;
}
