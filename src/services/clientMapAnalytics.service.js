import { addressParts, coordinates, cleanLocationText, normaliseLocation } from './clientLocation.js';

// One snapshot, one ledger aggregation and one owner per plot. Name matching is
// only allowed for a unique name in this site, including deleted names to avoid
// reassigning their money to a surviving namesake. Keep unlinked money visible.
export const CLIENT_MAP_SQL = `WITH
  site_members AS MATERIALIZED (
    SELECT id, full_name, member_type, member_types, status, address, city, village, district, state, pincode,
      occupation, latitude, longitude, geocode_source, geocode_precision FROM members WHERE site_id = $1
  ),
  name_index AS (
    SELECT UPPER(BTRIM(full_name)) AS name, MIN(id) AS id FROM site_members
    WHERE NULLIF(BTRIM(full_name), '') IS NOT NULL GROUP BY 1 HAVING COUNT(*) = 1
  ),
  latest_booking AS (
    SELECT DISTINCT ON (plot_id) plot_id, client_member_id FROM bookings
    WHERE site_id = $1 AND client_member_id IS NOT NULL AND COALESCE(status, '') NOT ILIKE 'cancel%'
    ORDER BY plot_id, id DESC
  ),
  paid AS (
    SELECT pp.plot_id, SUM(l.credit)::numeric(18,2) AS collected
    FROM ledger_entries l JOIN plot_payments pp ON pp.id = l.source_id AND pp.site_id = $1
    WHERE l.site_id = $1 AND l.source_key = 'plot_payments' AND l.credit <> 0 GROUP BY pp.plot_id
  ),
  plot_values AS (
    SELECT p.id, COALESCE((to_jsonb(p)->>'buyer_member_id')::integer, b.client_member_id, n.id) AS member_id,
      COALESCE(paid.collected, 0) AS collected,
      CASE WHEN UPPER(BTRIM(COALESCE(p.status, ''))) NOT IN
        ('COMPANY','CANCEL','CANCELLED','CANCELLATION','UNDER CANCELLATION','AVAILABLE','NOT FOR SALE','TRANSFERRED')
        AND COALESCE(p.sale_price,0) > 0 THEN p.sale_price ELSE 0 END AS sale_value
    FROM plots p LEFT JOIN latest_booking b ON b.plot_id = p.id
    LEFT JOIN name_index n ON n.name = UPPER(BTRIM(p.buyer_name))
    LEFT JOIN paid ON paid.plot_id = p.id WHERE p.site_id = $1
  ),
  member_money AS (
    SELECT member_id, COUNT(*)::int AS plot_count, SUM(collected) AS total_paid, SUM(sale_value) AS sale_value,
      SUM(CASE WHEN sale_value > 0 THEN GREATEST(sale_value-collected,0) ELSE 0 END) AS outstanding
    FROM plot_values GROUP BY member_id
  ),
  map_members AS (
    SELECT m.id, m.full_name AS name, m.member_type, COALESCE(m.member_types, ARRAY[m.member_type]) AS member_types,
      m.address, m.city, m.village, m.district, m.state, m.pincode, m.occupation,
      m.latitude AS lat, m.longitude AS lng, m.geocode_source AS source, m.geocode_precision AS precision,
      COALESCE(mm.plot_count,0) AS plot_count, COALESCE(mm.total_paid,0) AS total_paid,
      COALESCE(mm.sale_value,0) AS sale_value, COALESCE(mm.outstanding,0) AS outstanding
    FROM site_members m LEFT JOIN member_money mm ON mm.member_id = m.id
    WHERE LOWER(BTRIM(COALESCE(m.status,'active'))) <> 'deleted'
  )
  SELECT COALESCE((SELECT jsonb_agg(m ORDER BY m.id) FROM map_members m), '[]'::jsonb) AS members,
    (SELECT jsonb_build_object('plots', COUNT(*), 'total_paid', COALESCE(SUM(p.collected),0))
      FROM plot_values p WHERE NOT EXISTS (SELECT 1 FROM map_members m WHERE m.id = p.member_id)) AS unlinked`;

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
export function buildClientMap(rows, { siteId, unlinked = {} } = {}) {
  const members = [];
  const seen = new Set();
  const summary = { total: 0, geocoded: 0, manual: 0, approx: 0, with_address: 0, ready_to_locate: 0, invalid_pincode: 0 };
  for (const row of rows) {
    if (row.id == null || seen.has(String(row.id))) continue;
    seen.add(String(row.id));
    const address = addressParts(row);
    const coord = coordinates(row.lat, row.lng);
    const roles = [...new Set([row.member_type, ...(Array.isArray(row.member_types) ? row.member_types : [])].map(normaliseLocation).filter(Boolean))];
    const member = {
      ...row, ...address, lat: coord?.lat ?? null, lng: coord?.lng ?? null,
      address: cleanLocationText(row.address), name: cleanLocationText(row.name),
      member_type: roles[0] || 'OTHER', member_types: roles.length ? roles : ['OTHER'],
      location_status: coord ? (row.source === 'manual' ? 'manual' : 'approximate') : (address.can_geocode && row.source !== 'manual' ? 'pending' : 'needs_address'),
      total_paid: number(row.total_paid), outstanding: number(row.outstanding),
      sale_value: number(row.sale_value), plot_count: number(row.plot_count),
    };
    members.push(member);
    summary.total++;
    if (coord) { summary.geocoded++; summary[row.source === 'manual' ? 'manual' : 'approx']++; }
    if (address.has_address) summary.with_address++;
    if (!coord && address.can_geocode && row.source !== 'manual') summary.ready_to_locate++;
    if (address.invalid_pincode) summary.invalid_pincode++;
  }
  return {
    site_id: siteId, members, summary,
    unresolved: { count: summary.total - summary.geocoded, no_address: members.filter((m) => !m.has_address && m.lat === null).length },
    unlinked: { plots: number(unlinked.plots), total_paid: number(unlinked.total_paid) },
    generated_at: new Date().toISOString(),
  };
}
