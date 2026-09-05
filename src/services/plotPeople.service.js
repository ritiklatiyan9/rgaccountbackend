/** Group the same client across multiple plot records and relationship roles. */
export function groupPlotPeople(rows) {
  const members = new Map();
  const contacts = new Map();
  for (const row of rows) {
    const name = String(row.full_name || '').trim();
    const phone = String(row.phone || '').trim();
    if (!name && !phone) continue;
    const registered = row.member_id != null;
    const key = registered ? String(row.member_id) : `${name.toUpperCase()}|${phone.replace(/\D/g, '')}`;
    const map = registered ? members : contacts;
    if (!map.has(key)) map.set(key, { id: registered ? row.member_id : null, full_name: name, phone, plot_roles: [] });
    const person = map.get(key);
    if (!person.plot_roles.includes(row.role)) person.plot_roles.push(row.role);
  }
  return { members: [...members.values()], contacts: [...contacts.values()] };
}

/** Exact plot lookup across current and historical records within one site. */
export async function findPeopleByPlot(siteId, plotNo, pool) {
  const term = String(plotNo || '').trim().toUpperCase();
  if (!term) return { members: [], contacts: [] };
  const { rows } = await pool.query(`
    WITH matched_plots AS (
      SELECT p.* FROM plots p WHERE p.site_id = $1 AND UPPER(p.plot_no) = UPPER($2)
    ),
    plot_owners AS (
      SELECT DISTINCT m.* FROM members m
      WHERE m.site_id = $1 AND (
        EXISTS (SELECT 1 FROM matched_plots p WHERE UPPER(BTRIM(p.buyer_name)) = UPPER(BTRIM(m.full_name)))
        OR EXISTS (SELECT 1 FROM bookings b JOIN matched_plots p ON p.id = b.plot_id WHERE b.client_member_id = m.id)
      )
    ),
    related_people AS (
      SELECT NULL::integer AS member_id, v.name, v.phone, v.role
      FROM matched_plots p CROSS JOIN LATERAL (VALUES
        (p.buyer_name, NULL::text, 'Buyer'),
        (p.booking_by, NULL::text, 'Booked by'),
        (p.co_applicant_name, p.co_applicant_phone, 'Co-applicant'),
        (p.nominee_name, p.nominee_phone, 'Plot nominee')
      ) v(name, phone, role)
      UNION ALL
      SELECT b.client_member_id, NULL::text, NULL::text, 'Booking client'
      FROM bookings b JOIN matched_plots p ON p.id = b.plot_id
      UNION ALL
      SELECT pc.agent_id, NULL::text, NULL::text, 'Commission agent'
      FROM plot_commissions_v2 pc JOIN matched_plots p ON p.id = pc.plot_id WHERE pc.site_id = $1
      UNION ALL
      SELECT NULL::integer, pc.particular, NULL::text, 'Commission recipient'
      FROM plot_commissions pc WHERE pc.site_id = $1
        AND EXISTS (SELECT 1 FROM matched_plots p WHERE UPPER(pc.plot_no) = UPPER(p.plot_no))
      UNION ALL
      SELECT NULL::integer, v.name, NULL::text, v.role
      FROM plot_payments pp JOIN matched_plots p ON p.id = pp.plot_id
      CROSS JOIN LATERAL (VALUES
        (pp.buyer_name, 'Payment buyer'), (pp.booked_by, 'Payment booked by'), (pp.received_by, 'Payment received by')
      ) v(name, role)
      WHERE pp.site_id = $1
      UNION ALL
      SELECT NULL::integer, v.name, NULL::text, v.role
      FROM plot_registries pr
      CROSS JOIN LATERAL (VALUES
        (to_jsonb(pr)->>'buyer_name', 'Registry buyer'),
        (to_jsonb(pr)->>'farmer_name', 'Registry farmer'),
        (to_jsonb(pr)->>'seller_name', 'Registry seller')
      ) v(name, role)
      WHERE pr.site_id = $1 AND EXISTS (SELECT 1 FROM matched_plots p
        WHERE pr.plot_id = p.id OR (pr.plot_id IS NULL AND UPPER(pr.plot_no) = UPPER(p.plot_no)))
      UNION ALL
      SELECT NULL::integer, v.name, v.phone, v.role
      FROM plot_owners m CROSS JOIN LATERAL (VALUES
        (m.nominee_name, m.nominee_phone, 'KYC nominee'),
        (m.co_applicant_name, m.co_applicant_phone, 'KYC co-applicant')
      ) v(name, phone, role)
    )
    SELECT DISTINCT m.id AS member_id,
      COALESCE(m.full_name, r.name) AS full_name,
      COALESCE(NULLIF(m.phone, ''), NULLIF(m.alt_phone, ''), r.phone) AS phone, r.role
    FROM related_people r
    LEFT JOIN members m ON m.site_id = $1 AND (
      (r.member_id IS NOT NULL AND m.id = r.member_id)
      OR (r.member_id IS NULL AND (
        (NULLIF(BTRIM(r.name), '') IS NOT NULL AND UPPER(BTRIM(m.full_name)) = UPPER(BTRIM(r.name)))
        OR (NULLIF(regexp_replace(r.phone, '[^0-9]', '', 'g'), '') IS NOT NULL AND (
          regexp_replace(m.phone, '[^0-9]', '', 'g') = regexp_replace(r.phone, '[^0-9]', '', 'g')
          OR regexp_replace(m.alt_phone, '[^0-9]', '', 'g') = regexp_replace(r.phone, '[^0-9]', '', 'g')))
      ))
    )
    WHERE m.id IS NOT NULL OR (r.member_id IS NULL AND (NULLIF(BTRIM(r.name), '') IS NOT NULL OR NULLIF(BTRIM(r.phone), '') IS NOT NULL))
    ORDER BY full_name, role
  `, [siteId, term]);
  return groupPlotPeople(rows);
}
