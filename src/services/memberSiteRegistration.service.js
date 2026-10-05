import { assertMemberSiteAccess, normalizeMemberName } from './memberPhoneReuse.service.js';

// Use the same identity lookup for the preview and the registration itself.
// Empty or malformed legacy contacts must never match every empty contact.
const digits = (field) => `REGEXP_REPLACE(COALESCE(${field}, ''), '\\D', '', 'g')`;
const phone = (field) => `CASE WHEN ${digits(field)} ~ '^(0091|91|0)?[0-9]{10}$' THEN RIGHT(${digits(field)}, 10) END`;
const aadhaar = (field) => `CASE WHEN LENGTH(${digits(field)}) = 12 AND ${digits(field)} !~ '^([0-9])\\1{11}$' THEN ${digits(field)} END`;
const pan = (field) => `CASE WHEN UPPER(REGEXP_REPLACE(COALESCE(${field}, ''), '[^A-Za-z0-9]', '', 'g')) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN UPPER(REGEXP_REPLACE(${field}, '[^A-Za-z0-9]', '', 'g')) END`;

export const findSiteRegistrationMatches = async (db, { memberIds, siteIds, lock = false, includeProfile = false }) => {
  if (!siteIds.length) return [];
  const { rows } = await db.query(`
    WITH identities AS MATERIALIZED (
      SELECT id, site_id, shared_profile_id, full_name, father_name, date_of_birth,
             ${phone('phone')} AS match_phone, ${aadhaar('aadhar_no')} AS match_aadhaar, ${pan('pan_no')} AS match_pan,
             UPPER(TRIM(full_name)) AS match_name
        FROM members WHERE id = ANY($1::int[]) OR site_id = ANY($2::int[])
    ), sources AS MATERIALIZED (
      SELECT * FROM identities WHERE id = ANY($1::int[])
    ), candidates AS MATERIALIZED (
      SELECT * FROM identities WHERE site_id = ANY($2::int[])
    ), matches AS (
      SELECT source.id AS source_id, candidate.id AS target_id FROM sources source JOIN candidates candidate ON candidate.id = source.id
      UNION
      SELECT source.id, candidate.id FROM sources source JOIN candidates candidate ON candidate.shared_profile_id = source.shared_profile_id
      UNION
      SELECT source.id, candidate.id FROM sources source JOIN candidates candidate ON candidate.match_phone = source.match_phone
      UNION
      SELECT source.id, candidate.id FROM sources source JOIN candidates candidate ON candidate.match_aadhaar = source.match_aadhaar
      UNION
      SELECT source.id, candidate.id FROM sources source JOIN candidates candidate ON candidate.match_pan = source.match_pan
      UNION
      SELECT source.id, candidate.id FROM sources source JOIN candidates candidate ON candidate.match_name = source.match_name
       WHERE source.match_phone IS NULL AND source.match_aadhaar IS NULL AND source.match_pan IS NULL
         AND (NULLIF(source.father_name, '') IS NULL OR UPPER(candidate.father_name) = UPPER(source.father_name))
         AND (NULLIF(source.date_of_birth::text, '') IS NULL OR candidate.date_of_birth = source.date_of_birth)
    )
    SELECT ${includeProfile ? 'target.*' : 'target.id, target.site_id, target.full_name, target.shared_profile_id'},
           source.id AS source_member_id, kyc.status AS kyc_status
      FROM matches
      JOIN sources source ON source.id = matches.source_id
      JOIN members target ON target.id = matches.target_id
      LEFT JOIN LATERAL (
        SELECT status FROM kyc_cases
         WHERE client_member_id = target.id AND site_id = target.site_id
         ORDER BY CASE status WHEN 'VERIFIED' THEN 4 WHEN 'OCR_DONE' THEN 3 WHEN 'OCR_PENDING' THEN 2 ELSE 1 END DESC,
                  updated_at DESC NULLS LAST, id DESC
         LIMIT 1
      ) kyc ON true
     WHERE source.id = ANY($1::int[]) AND target.site_id = ANY($2::int[])
     ORDER BY source.id, target.site_id, (target.id = source.id) DESC,
              (target.shared_profile_id = source.shared_profile_id) DESC NULLS LAST, target.id
     ${lock ? 'FOR UPDATE OF target' : ''}`, [memberIds, siteIds]);
  return rows;
};

export const getSiteRegistrationStatus = async (db, { memberIds, user }) => {
  const { rows: sources } = await db.query('SELECT id, site_id, full_name FROM members WHERE id = ANY($1::int[]) ORDER BY id', [memberIds]);
  if (sources.length !== memberIds.length) {
    throw Object.assign(new Error('One or more selected members were not found'), { statusCode: 404 });
  }
  for (const siteId of new Set(sources.map((source) => source.site_id))) {
    if (!await assertMemberSiteAccess(db, user, siteId)) {
      throw Object.assign(new Error('One or more selected members are unavailable to your account'), { statusCode: 403 });
    }
  }
  const isAdmin = ['admin', 'super_admin'].includes(user.role);
  const { rows: sites } = await db.query(
    `SELECT s.id, s.name FROM sites s WHERE s.organization_id = $1
      ${isAdmin ? '' : 'AND EXISTS (SELECT 1 FROM user_sites us WHERE us.site_id = s.id AND us.user_id = $2)'}
      ORDER BY s.name, s.id`, isAdmin ? [user.organization_id] : [user.organization_id, user.id]);
  const matches = await findSiteRegistrationMatches(db, { memberIds, siteIds: sites.map((site) => site.id) });
  const bySourceSite = new Map();
  for (const match of matches) {
    const key = `${match.source_member_id}:${match.site_id}`;
    if (!bySourceSite.has(key)) bySourceSite.set(key, []);
    bySourceSite.get(key).push(match);
  }
  return {
    members: sources.map((source) => ({
      id: source.id, full_name: source.full_name, site_id: source.site_id,
      kyc_status: bySourceSite.get(`${source.id}:${source.site_id}`)?.[0]?.kyc_status || null,
    })),
    sites: sites.map((site) => {
      const registrations = sources.map((source) => {
        const candidates = bySourceSite.get(`${source.id}:${site.id}`) || [];
        const match = candidates[0];
        return {
          source_member_id: source.id, source_name: source.full_name,
          member_id: match?.id || null, full_name: match?.full_name || null,
          registered: Boolean(match), kyc_status: match?.kyc_status || null,
          different_name: Boolean(match && normalizeMemberName(match.full_name) !== normalizeMemberName(source.full_name)),
          registration_count: candidates.length,
        };
      });
      return {
        site_id: site.id, site_name: site.name, registrations,
        registered_count: registrations.filter((entry) => entry.registered).length,
        verified_count: registrations.filter((entry) => entry.kyc_status === 'VERIFIED').length,
        missing_count: registrations.filter((entry) => !entry.registered).length,
      };
    }),
  };
};
