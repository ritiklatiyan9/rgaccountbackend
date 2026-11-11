// A member can be registered at several sites and under several roles. Browse
// people, while retaining the actual member IDs used by commission records.
export async function listCommissionReceivers(db, { organizationId, siteId, cursor = 0, limit = 30, query = '' }) {
  const escaped = query.toLowerCase().replace(/[\\%_]/g, value => `\\${value}`);
  const rawDigits = query.replace(/\D/g, '');
  const digits = ((rawDigits.length === 12 && rawDigits.startsWith('91'))
    || (rawDigits.length === 14 && rawDigits.startsWith('0091'))
    || (rawDigits.length === 11 && rawDigits.startsWith('0'))) ? rawDigits.slice(-10) : rawDigits;
  const { rows } = await db.query(`WITH normalized AS (
    SELECT m.id,m.site_id,m.full_name,m.phone,m.member_type,
      COALESCE(m.member_types,ARRAY[m.member_type]) AS roles,
      regexp_replace(lower(COALESCE(m.full_name,'')),'[^[:alnum:]]','','g') AS person_name,
      CASE WHEN length(COALESCE(m.phone,''))<=32
        AND regexp_replace(COALESCE(m.phone,''),'[[:space:]()+-]','','g') ~ '^(0091|91|0)?[6-9][0-9]{9}$'
        THEN right(regexp_replace(m.phone,'[^0-9]','','g'),10) ELSE '' END AS person_phone,
      CASE WHEN length(COALESCE(to_jsonb(m)->>'aadhar_no',''))<=32 THEN regexp_replace(COALESCE(to_jsonb(m)->>'aadhar_no',''),'[[:space:]-]','','g') ELSE '' END AS identity_aadhaar,
      upper(regexp_replace(COALESCE(to_jsonb(m)->>'pan_no',''),'[[:space:]]','','g')) AS identity_pan,
      COALESCE('BROKER'=ANY(COALESCE(m.member_types,ARRAY[m.member_type])),false) AS is_broker,
      (COALESCE(to_jsonb(m)->>'is_active','true')<>'false'
        AND upper(trim(COALESCE(to_jsonb(m)->>'status','ACTIVE'))) NOT IN ('INACTIVE','BLOCKED','DISABLED','DEACTIVATED','DELETED','SUSPENDED')) AS is_active
    FROM members m JOIN sites s ON s.id=m.site_id WHERE s.organization_id=$1
  ), keyed AS (
    SELECT *,CASE WHEN person_name<>'' AND person_phone<>''
      THEN json_build_array(person_name,person_phone)::text ELSE 'record:'||id::text END AS person_key
    FROM normalized
  ), matched AS (
    SELECT DISTINCT person_key FROM keyed WHERE $3::text=''
      OR lower(full_name) LIKE $4 ESCAPE '\\'
      OR ($5::text<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g') LIKE $6)
  ), candidates AS (
    SELECT k.* FROM keyed k JOIN matched q ON q.person_key=k.person_key
  ), identities AS (
    SELECT person_key,
      COUNT(DISTINCT identity_aadhaar) FILTER(WHERE identity_aadhaar ~ '^[2-9][0-9]{11}$') AS aadhaar_count,
      COUNT(DISTINCT identity_pan) FILTER(WHERE identity_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$') AS pan_count
    FROM candidates GROUP BY person_key
  ), people AS (
    SELECT c.*,CASE WHEN i.aadhaar_count>1 OR i.pan_count>1
      THEN c.person_key||':record:'||c.id::text ELSE c.person_key END AS group_key,
      (c.is_broker AND c.is_active AND c.person_phone<>'' AND c.identity_aadhaar ~ '^[2-9][0-9]{11}$') AS partner_app_eligible
    FROM candidates c JOIN identities i USING(person_key)
  ), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY partner_app_eligible DESC,
      is_active DESC,is_broker DESC,(site_id=$8) DESC,id ASC) AS preference FROM people
  ), grouped AS (
    SELECT group_key,MIN(id) AS directory_id,array_agg(id ORDER BY id) AS member_ids
    FROM ranked GROUP BY group_key
  ), group_roles AS (
    SELECT group_key,array_agg(DISTINCT role ORDER BY role) AS member_types
    FROM ranked CROSS JOIN LATERAL unnest(roles) role WHERE role IS NOT NULL GROUP BY group_key
  ) SELECT r.id,r.full_name,r.phone,r.member_type,r.partner_app_eligible,
      g.member_ids,g.directory_id,gr.member_types
    FROM ranked r JOIN grouped g USING(group_key) LEFT JOIN group_roles gr USING(group_key)
    WHERE r.preference=1 AND g.directory_id>$2 ORDER BY g.directory_id LIMIT $7`,
  [organizationId, cursor, query, `%${escaped}%`, digits, `%${digits}%`, limit + 1, siteId]);
  const page = rows.slice(0, limit);
  return { members: page.map(({ directory_id, ...member }) => member),
    has_more: rows.length > limit,
    next_cursor: rows.length > limit ? String(page.at(-1).directory_id) : null,
    directory_version: 2 };
}
