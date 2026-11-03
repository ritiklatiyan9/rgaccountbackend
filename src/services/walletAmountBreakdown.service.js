import { accessibleSite, holder, validateHolder } from './loyaltyVault.service.js';
import { canViewAllWallets } from './walletVisibility.service.js';
import { walletError, pagination, positiveId } from './wallet.service.js';
import { siteVaultAccountsCte } from './loyaltyVaultSite.service.js';
import { readWalletReportingOpenings } from './walletReportingOpening.service.js';
import { adminWalletCashStates, walletWithCashInHand } from './adminWalletCash.service.js';
import { walletHistoryJoins, walletHistorySelect } from './walletHistory.service.js';
import { holderCashPaymentsCte,addHolderWalletActivity } from './walletCashDeductions.service.js';

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
    deductions: user.cash_deductions?.version===2&&user.cash_deductions.scope==='holder' ? user.cash_deductions.payment_total : null, categories: user.cash_deductions || null };
}

// Identical posting predicates to the wallet table. Amounts include corrections,
// not just positive receipts. A handover enters this list only when posted.
async function receiptEntries(db, { organizationId, siteId, userId, section, opening, page, limit, offset }) {
  const params = [organizationId, siteId, `user:${userId}`, opening?.started_at || null];
  const where = `e.organization_id=$1 AND e.site_id=$2 AND e.holder_key=$3
    AND ($4::timestamptz IS NULL OR e.created_at >= $4::timestamptz)
    AND ${section === 'received' ? "e.kind NOT IN ('transfer_out','imprest_out','adjustment')" : "e.kind='transfer_out'"}`;
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

// The deductions list uses exactly the same maker, posting and float-funding
// predicates as the table. Gross giving and calculated cash changes belong to
// separate columns and never appear as invented payment rows.
export const walletDeductionEntriesCte = `WITH scopes AS (
  SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(holder_key text,holder_id integer,started_at timestamptz)
), ${holderCashPaymentsCte}`;

export async function readWalletDeductionEntries(db,{organizationId,siteId,userId,opening,endDate,page,limit,offset}) {
  const params=[organizationId,siteId,JSON.stringify([{holder_key:`user:${userId}`,holder_id:Number(userId),started_at:opening?.started_at??null}]),endDate];
  const {rows:[aggregate]}=await db.query(`${walletDeductionEntriesCte}
    SELECT count(*)::int AS total,COALESCE(sum(payment_amount),0)::text AS net FROM holder_cash_payments`,params);
  const {rows}=await db.query(`${walletDeductionEntriesCte}
    SELECT 'cash:'||l.id::text AS id,'payment'::text AS entry_type,
      CASE WHEN l.source_key IN ('plot_commission_payments','commission_payments') THEN 'commission'
        WHEN l.source_key='expenses' THEN 'expenses' ELSE 'other_cash_payments' END AS category,
      l.site_id,l.maker_id,l.maker_id AS created_by,l.created_at,l.entry_date::text AS transaction_date,
      l.payment_amount::text AS amount,l.particular AS description,
      concat_ws(E'\n',NULLIF(l.remarks,''),NULLIF(to_jsonb(l)->>'linked_detail','')) AS note,
      l.source_key AS source_table,l.source_id,to_jsonb(l)->>'entity_name' AS person_name,
      COALESCE(maker.name,to_jsonb(l)->>'created_by_name') AS actor_name
    FROM holder_cash_payments l LEFT JOIN users maker ON maker.id=l.maker_id AND maker.organization_id=$1
    ORDER BY l.created_at DESC,l.id DESC LIMIT $5 OFFSET $6`,[...params,limit,offset]);
  return {entries:rows,total:aggregate.total,entries_total:money(cents(aggregate.net)),page,limit};
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
  const endDate=(await db.query("SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS end_date")).rows[0].end_date;
  await addHolderWalletActivity(db,{organizationId:actor.organization_id,siteId,holders:[user],endDate});
  const opening = (await readWalletReportingOpenings(actor.organization_id, siteId, db)).find(row => row.holder_id === userId) || null;
  const summary = walletAmountSummary(user, opening);
  const base = { site_id: siteId, holder_id: userId, user: { id: userId, name: user.name, role: user.role }, section,
    summary, opening, deductions_available: user.cash_deductions?.version===2&&user.cash_deductions.scope==='holder', as_of: new Date().toISOString() };
  if (section === 'deductions' && !base.deductions_available) return { ...base, entries: [], total: 0, entries_total: null, page, limit };
  const scope = { organizationId: actor.organization_id, siteId, userId, section, opening, page, limit, offset };
  const entries = section === 'deductions'
    ? await readWalletDeductionEntries(db, { ...scope, deductions: user.cash_deductions,
      endDate })
    : await receiptEntries(db, scope);
  const displayed = summary[section === 'handed-over' ? 'handed_over' : section];
  const includedOpening = section === 'received' ? cents(opening?.opening_cash || '0') : 0n;
  return { ...base, ...entries, reconciliation_difference: money(cents(displayed) - includedOpening - cents(entries.entries_total)) };
}
