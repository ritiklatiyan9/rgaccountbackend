// The account row is an organization-wide compatibility cache and lock. Site
// custody is derived from immutable postings; unassigned legacy cash never
// becomes spendable merely because the sidebar selects a different project.
export function siteVaultAccountsCte(organization = '$2', site = '$4') {
  return `site_postings AS (
    SELECT holder_key,holder_type,holder_id,sum(amount) AS balance,max(created_at) AS updated_at,count(*)::int AS entry_count
    FROM loyalty_vault_entries WHERE organization_id=${organization} AND site_id=${site}
    GROUP BY holder_key,holder_type,holder_id
  ), site_reservations AS (
    SELECT from_holder_type||':'||from_holder_id::text AS holder_key,from_holder_type AS holder_type,from_holder_id AS holder_id,
      sum(amount) AS reserved_balance,max(created_at) AS updated_at
    FROM loyalty_vault_transfers WHERE organization_id=${organization} AND site_id=${site} AND status='pending'
    GROUP BY from_holder_type,from_holder_id
  ), site_accounts AS (
    SELECT COALESCE(p.holder_key,r.holder_key) AS holder_key,COALESCE(p.holder_type,r.holder_type) AS holder_type,
      COALESCE(p.holder_id,r.holder_id) AS holder_id,COALESCE(p.balance,0) AS balance,COALESCE(r.reserved_balance,0) AS reserved_balance,
      GREATEST(p.updated_at,r.updated_at) AS updated_at,COALESCE(p.entry_count,0) AS entry_count
    FROM site_postings p FULL JOIN site_reservations r USING(holder_key)
  )`;
}
