// Names are a legacy fallback, not an identity: two members in the same site
// may share a name. All placeholders use [siteId, memberId].
export const uniqueMemberNameMatch = (nameSql) => `EXISTS (
  SELECT 1 FROM members ledger_member
  WHERE ledger_member.id = $2 AND ledger_member.site_id = $1
    AND NULLIF(BTRIM(${nameSql}), '') IS NOT NULL
    AND UPPER(BTRIM(ledger_member.full_name)) = UPPER(BTRIM(${nameSql}))
    AND NOT EXISTS (
      SELECT 1 FROM members duplicate_member
      WHERE duplicate_member.site_id = ledger_member.site_id
        AND duplicate_member.id <> ledger_member.id
        AND UPPER(BTRIM(duplicate_member.full_name)) = UPPER(BTRIM(ledger_member.full_name))
    )
)`;

export const memberTransactionMatch = (alias, names, { assigned = false } = {}) => `(
  ${alias}.mapped_member_id = $2
  ${assigned ? `OR ${alias}.assigned_user_id = $2` : ''}
  OR (${alias}.mapped_member_id IS NULL AND ${alias}.mapped_user_id IS NULL
    ${assigned ? `AND ${alias}.assigned_user_id IS NULL` : ''}
    AND (${names.map(uniqueMemberNameMatch).join(' OR ')}))
)`;

// JSON extraction also supports installations where the additive buyer-link
// migration has not run yet. Bookings remain an authoritative buyer link.
export const LEDGER_PLOT_BUYER_JOIN = `LEFT JOIN LATERAL (
  SELECT COALESCE(
    (to_jsonb(p)->>'buyer_member_id')::integer,
    (SELECT b.client_member_id FROM bookings b
      WHERE b.plot_id = p.id AND b.site_id = p.site_id
        AND b.client_member_id IS NOT NULL
        AND COALESCE(b.status, '') NOT ILIKE 'cancel%'
      ORDER BY b.id DESC LIMIT 1)
  ) AS member_id
) ledger_buyer ON true`;

export const MEMBER_PLOT_PAYMENT_MATCH = `(
  pp.mapped_member_id = $2
  OR (pp.mapped_member_id IS NULL AND pp.mapped_user_id IS NULL AND (
    CASE WHEN NULLIF(BTRIM(pp.buyer_name), '') IS NULL
           OR UPPER(BTRIM(pp.buyer_name)) = UPPER(BTRIM(p.buyer_name))
      THEN CASE WHEN ledger_buyer.member_id IS NOT NULL
        THEN ledger_buyer.member_id = $2
        ELSE ${uniqueMemberNameMatch('p.buyer_name')} END
      ELSE ${uniqueMemberNameMatch('pp.buyer_name')}
    END
  ))
)`;
