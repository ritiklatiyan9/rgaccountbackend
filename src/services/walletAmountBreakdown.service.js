import { accessibleSite, holder, validateHolder } from './loyaltyVault.service.js';
import { canViewAllWallets } from './walletVisibility.service.js';
import { walletError, pagination, positiveId } from './wallet.service.js';
import { siteVaultAccountsCte } from './loyaltyVaultSite.service.js';
import { readWalletReportingOpenings } from './walletReportingOpening.service.js';
import { adminWalletCashStates, walletWithCashInHand } from './adminWalletCash.service.js';
import { walletHistoryJoins, walletHistorySelect } from './walletHistory.service.js';

const cents = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
  if (!match) throw walletError('The wallet totals could not be reconciled.', 503);
  return (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1n : 1n);
};
const money = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;

export function walletAmountSummary(user, opening) {
  const received = cents(user.total_received) - cents(opening?.received_at_start || '0') + cents(opening?.opening_cash || '0');
  const handed = cents(user.total_handover) - cents(opening?.handovers_at_start || '0');
  return { received: money(received), handed_over: money(handed), current_cash: money(cents(user.balance)),
    deductions: user.cash_deductions?.total ?? null, categories: user.cash_deductions || null };
}

// Identical posting predicates to the wallet table. Amounts include corrections,
// not just positive receipts. A handover enters this list only when posted.
async function receiptEntries(db, { organizationId, siteId, userId, section, opening, page, limit, offset }) {
  const params = [organizationId, siteId, `user:${userId}`, opening?.started_at || null];
  const where = `e.organization_id=$1 AND e.site_id=$2 AND e.holder_key=$3
    AND ($4::timestamptz IS NULL OR e.created_at >= $4::timestamptz)
    AND ${section === 'received' ? "e.kind IS DISTINCT FROM 'transfer_out' AND e.kind IS DISTINCT FROM 'adjustment'" : "e.kind='transfer_out'"}`;
  const sign = section === 'received' ? '' : '-';
  const { rows: [aggregate] } = await db.query(`SELECT count(*)::int AS total,
    COALESCE(sum(${sign}e.amount),0)::text AS net FROM loyalty_vault_entries e WHERE ${where}`, params);
  // Source hydration is bounded to this page; never hydrate an entire ledger.
  const { rows } = await db.query(`WITH site_history AS MATERIALIZED (
    SELECT e.* FROM loyalty_vault_entries e WHERE ${where} ORDER BY e.id DESC LIMIT $5 OFFSET $6
  ) SELECT ${walletHistorySelect},(${sign}e.amount)::text AS contribution,
    (e.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS recorded_date
    ${walletHistoryJoins} ORDER BY e.id DESC`, [...params, limit, offset]);
  return { entries: rows.map(({ balance_after: _privateSnapshot, ...row }) => ({ ...row,
    id: `wallet:${row.id}`, wallet_entry_id: row.id, amount: row.contribution,
    transaction_date: row.transaction_date || row.recorded_date,
    category: section === 'received' ? 'received' : 'handed_over', entry_type: 'wallet',
  })), total: aggregate.total, entries_total: money(cents(aggregate.net)), page, limit };
}

// Positive imprest holdings are the site's cash deduction. Going below zero
// must not deduct (or release) cash twice; each row shows its actual float effect.
export const walletDeductionEntriesCte = `WITH cash_payments AS (
  SELECT 'cash:'||l.id::text AS id,
    CASE WHEN l.source_key IN ('plot_commission_payments','commission_payments') THEN 'commission'
      WHEN l.source_key='expenses' THEN 'expenses' ELSE 'other_cash_payments' END AS category,
    'payment'::text AS entry_type,l.created_at,l.entry_date::text AS transaction_date,
    GREATEST(l.debit,0)+GREATEST(-l.credit,0) AS amount,
    l.particular AS description,concat_ws(E'\n',NULLIF(l.remarks,''),NULLIF(to_jsonb(l)->>'linked_detail','')) AS note,
    l.source_key AS source_table,l.source_id,
    to_jsonb(l)->>'entity_name' AS person_name,to_jsonb(l)->>'created_by_name' AS actor_name,
    NULL::numeric AS original_amount,NULL::numeric AS float_before,NULL::numeric AS float_after
  FROM ledger_entries l JOIN sites s ON s.id=l.site_id AND s.organization_id=$1
  WHERE l.site_id=$2 AND l.bucket='cash' AND l.entry_date<$5::date
    AND l.created_at>=$4::timestamptz AND GREATEST(l.debit,0)+GREATEST(-l.credit,0)<>0
), imprest_running AS (
  SELECT il.*,u.name AS person_name,
    sum(il.amount) OVER(PARTITION BY il.user_id ORDER BY il.created_at,il.id ROWS UNBOUNDED PRECEDING) AS running
  FROM imprest_ledger il JOIN sites s ON s.id=il.site_id AND s.organization_id=$1
    JOIN users u ON u.id=il.user_id AND LOWER(COALESCE(u.role,'')) NOT IN ('admin','super_admin')
  WHERE il.site_id=$2 AND il.created_at<$5::date
), imprest_movements AS (
  SELECT 'imprest:'||i.id::text AS id,'imprest'::text AS category,'imprest'::text AS entry_type,
    i.created_at,(i.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS transaction_date,
    GREATEST(i.running,0)-GREATEST(i.running-i.amount,0) AS amount,
    COALESCE(to_jsonb(i)->>'description',to_jsonb(i)->>'remarks',to_jsonb(i)->>'type','Imprest movement') AS description,
    to_jsonb(i)->>'source_module' AS note,NULL::text AS source_table,
    NULLIF(to_jsonb(i)->>'reference_id','')::integer AS source_id,i.person_name,actor.name AS actor_name,
    i.amount AS original_amount,GREATEST(i.running-i.amount,0) AS float_before,GREATEST(i.running,0) AS float_after
  FROM imprest_running i LEFT JOIN users actor ON actor.id=NULLIF(to_jsonb(i)->>'created_by','')::integer AND actor.organization_id=$1
  WHERE i.created_at>=$4::timestamptz AND GREATEST(i.running,0)-GREATEST(i.running-i.amount,0)<>0
), adjustments AS (
  SELECT 'adjustment:'||e.id::text AS id,'other_adjustments'::text AS category,'adjustment'::text AS entry_type,
    e.created_at,(e.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS transaction_date,-e.amount AS amount,
    e.description,e.details->>'remarks' AS note,NULL::text AS source_table,e.id AS source_id,
    NULL::text AS person_name,actor.name AS actor_name,NULL::numeric AS original_amount,NULL::numeric AS float_before,NULL::numeric AS float_after
  FROM loyalty_vault_entries e LEFT JOIN users actor ON actor.id=e.actor_id AND actor.organization_id=$1
  WHERE e.organization_id=$1 AND e.site_id=$2 AND e.holder_key=$3 AND e.kind='adjustment' AND e.created_at>=$4::timestamptz
), items AS (
  SELECT * FROM cash_payments UNION ALL SELECT * FROM imprest_movements UNION ALL SELECT * FROM adjustments
), reconciliation AS (
  SELECT $6::numeric-COALESCE(sum(amount) FILTER(WHERE category='other_adjustments'),0) AS amount FROM items
), all_items AS (
  SELECT * FROM items UNION ALL
  SELECT 'reconciliation','other_adjustments','reconciliation',now(),NULL::text,amount,
    'Other custody / balance reconciliation',
    'Calculated from opening cash, received, accepted handovers and current cash, after the itemised payments, imprest and adjustments. This is not a payment.',
    NULL::text,NULL::integer,NULL::text,NULL::text,NULL::numeric,NULL::numeric,NULL::numeric
  FROM reconciliation WHERE amount<>0
)`;

export async function readWalletDeductionEntries(db, { organizationId, siteId, userId, opening, deductions, endDate, page, limit, offset }) {
  const params = [organizationId, siteId, `user:${userId}`, opening.started_at, endDate, deductions.other_adjustments];
  const { rows: [aggregate] } = await db.query(`${walletDeductionEntriesCte}
    SELECT count(*)::int AS total,COALESCE(sum(amount),0)::text AS net FROM all_items`, params);
  const { rows } = await db.query(`${walletDeductionEntriesCte} SELECT *,amount::text AS amount,
    original_amount::text AS original_amount,float_before::text AS float_before,float_after::text AS float_after
    FROM all_items ORDER BY created_at DESC,id DESC LIMIT $7 OFFSET $8`, [...params, limit, offset]);
  return { entries: rows, total: aggregate.total, entries_total: money(cents(aggregate.net)), page, limit };
}

// The caller wraps this in one repeatable, read-only snapshot. Existing role,
// wallet visibility, organization and site rules apply before any financial read.
export async function getWalletAmountBreakdown(db, { actor, siteId: requestedSite, userId: requestedUser, section, ...query },
  { cashStateReader = adminWalletCashStates } = {}) {
  if (!actor?.is_active || !['admin','super_admin','sub_admin'].includes(actor.role) || actor.wallet_can_read === false) throw walletError('Cash Wallet access is disabled for your account.', 403);
  if (!['received','handed-over','deductions'].includes(section)) throw walletError('Choose Received, Handed over or Deductions.');
  const userId = positiveId(requestedUser), siteId = await accessibleSite(actor, requestedSite, db);
  if (!canViewAllWallets(actor) && userId !== Number(actor.id)) throw walletError('You can view only your own Cash Wallet details.', 403);
  await validateHolder(actor, holder('user', userId), db, siteId, true);
  const { page, limit, offset } = pagination(query);
  const { rows: [record] } = await db.query(`WITH ${siteVaultAccountsCte('$1','$2')}
    SELECT u.id,u.name,u.role,COALESCE(a.balance,0)::text AS balance,
      COALESCE(a.total_received,0)::text AS total_received,COALESCE(a.total_handover,0)::text AS total_handover,
      COALESCE(a.total_adjustments,0)::text AS total_adjustments
    FROM users u LEFT JOIN site_accounts a ON a.holder_key='user:'||u.id::text
    WHERE u.id=$3 AND u.organization_id=$1`, [actor.organization_id, siteId, userId]);
  if (!record) throw walletError('Cash Wallet user not found.', 404);
  const states = record.role === 'admin' ? await cashStateReader(actor.organization_id, siteId, db, null, { includeDeductions: true }) : new Map();
  const user = walletWithCashInHand({ ...record, holder_type: 'user', holder_id: userId }, states);
  const opening = (await readWalletReportingOpenings(actor.organization_id, siteId, db)).find(row => row.holder_id === userId) || null;
  const summary = walletAmountSummary(user, opening);
  const base = { site_id: siteId, holder_id: userId, user: { id: userId, name: user.name, role: user.role }, section,
    summary, opening, deductions_available: !!user.cash_deductions, as_of: new Date().toISOString() };
  if (section === 'deductions' && !user.cash_deductions) return { ...base, entries: [], total: 0, entries_total: null, page, limit };
  const scope = { organizationId: actor.organization_id, siteId, userId, section, opening, page, limit, offset };
  const entries = section === 'deductions'
    ? await readWalletDeductionEntries(db, { ...scope, deductions: user.cash_deductions,
      endDate: (await db.query("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS end_date")).rows[0].end_date })
    : await receiptEntries(db, scope);
  const displayed = summary[section === 'handed-over' ? 'handed_over' : section];
  const includedOpening = section === 'received' ? cents(opening?.opening_cash || '0') : 0n;
  return { ...base, ...entries, reconciliation_difference: money(cents(displayed) - includedOpening - cents(entries.entries_total)) };
}
