// The account row is an organization-wide compatibility cache and lock. Site
// custody is derived from immutable postings; unassigned legacy cash never
// becomes spendable merely because the sidebar selects a different project.
// Net receipts include incoming handovers and receipt corrections. Outgoing
// handovers count only once posted on acceptance. The legacy total_in includes
// balance adjustments; total_received excludes them so an alignment can never
// be presented as cash received. These totals reconcile to the recorded ledger,
// before the separate Admin cash-in-hand projection.
export function siteVaultAccountsCte(organization = '$2', site = '$4') {
  return `site_postings AS (
    SELECT holder_key,holder_type,holder_id,sum(amount) AS balance,
      COALESCE(sum(amount) FILTER (WHERE kind NOT IN ('transfer_out','imprest_out')),0) AS total_in,
      COALESCE(sum(amount) FILTER (WHERE kind NOT IN ('transfer_out','imprest_out') AND kind IS DISTINCT FROM 'adjustment'),0) AS total_received,
      COALESCE(sum(amount) FILTER (WHERE kind='adjustment'),0) AS total_adjustments,
      -COALESCE(sum(amount) FILTER (WHERE kind='transfer_out'),0) AS total_handover,
      -COALESCE(sum(amount) FILTER (WHERE kind='imprest_out'),0) AS total_imprest_out,
      max(created_at) AS updated_at,count(*)::int AS entry_count
    FROM loyalty_vault_entries WHERE organization_id=${organization} AND site_id=${site}
    GROUP BY holder_key,holder_type,holder_id
  ), site_accounts AS (
    SELECT p.*,0::numeric AS reserved_balance FROM site_postings p
  )`;
}
