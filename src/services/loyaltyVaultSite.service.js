// The account row is an organization-wide compatibility cache and lock. Site
// custody is derived from immutable postings; unassigned legacy cash never
// becomes spendable merely because the sidebar selects a different project.
// Net receipts include incoming handovers and receipt corrections. Outgoing
// handovers count only once posted on acceptance, so total_in - total_handover
// always reconciles to the current wallet, across every page of its cashbook.
export function siteVaultAccountsCte(organization = '$2', site = '$4') {
  return `site_postings AS (
    SELECT holder_key,holder_type,holder_id,sum(amount) AS balance,
      COALESCE(sum(amount) FILTER (WHERE kind IS DISTINCT FROM 'transfer_out'),0) AS total_in,
      -COALESCE(sum(amount) FILTER (WHERE kind='transfer_out'),0) AS total_handover,
      max(created_at) AS updated_at,count(*)::int AS entry_count
    FROM loyalty_vault_entries WHERE organization_id=${organization} AND site_id=${site}
    GROUP BY holder_key,holder_type,holder_id
  ), site_accounts AS (
    SELECT p.*,0::numeric AS reserved_balance FROM site_postings p
  )`;
}
