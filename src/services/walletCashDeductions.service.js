const paise = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) throw new Error('Invalid wallet reconciliation amount');
  return (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1n : 1n);
};
const money = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;

export function walletCashDeductions({ opening, totals, state, spending, imprest, imprestGiven = null, siteId, holderId }) {
  const received = paise(opening.opening_cash) + paise(totals.total_received) - paise(opening.received_at_start);
  const handed = paise(totals.total_handover) - paise(opening.handovers_at_start);
  const current = paise(state.balance);
  const commission = paise(spending.commission);
  const expenses = paise(spending.expenses);
  const otherPayments = paise(spending.other_cash_payments);
  const float = paise(imprest);
  const total = received - handed - current;
  return { version: 1, site_id: Number(siteId), holder_id: Number(holderId), started_at: opening.started_at,
    received: money(received), handed_over: money(handed), current_cash: money(current),
    commission: money(commission), expenses: money(expenses), imprest: money(float),
    ...(imprestGiven == null ? {} : { imprest_given: money(paise(imprestGiven)) }),
    other_cash_payments: money(otherPayments),
    ...(Array.isArray(spending.modules) ? { modules: spending.modules } : {}),
    // The remainder is explicit: custody changes, reservations, source edits and
    // alignments must never be silently relabelled as an expense or commission.
    other_adjustments: money(total - commission - expenses - float - otherPayments), total: money(total) };
}

// Called only for the wallet display, inside the same read-only snapshot as
// current cash. Batch every aligned Admin in this site; never query per row.
export async function addWalletCashDeductions(database, { organizationId, siteId, states, totals, endDate }) {
  if (!states.size) return states;
  const { rows } = await database.query(`SELECT a.setting_value FROM application_settings a
    JOIN sites s ON s.id=a.site_id AND s.organization_id=$1
    WHERE a.site_id=$2 AND a.setting_key LIKE 'wallet_reporting_opening:user:%'`, [organizationId, siteId]);
  const openings = rows.map(row => row.setting_value).filter(row => row?.version === 1 && row.holder_type === 'user'
    && row.organization_id === Number(organizationId) && row.site_id === Number(siteId)
    && Number.isSafeInteger(row.holder_id) && states.has(`user:${row.holder_id}`)
    && Number.isFinite(Date.parse(row.started_at)) && typeof row.operation_key === 'string' && !!row.operation_key
    && ['opening_cash','received_at_start','handovers_at_start','adjustments_at_start','recorded_balance_at_start']
      .every(key => /^-?\d+(?:\.\d{1,2})?$/.test(String(row[key] ?? ''))));
  if (!openings.length) return states;
  const scopes = JSON.stringify(openings.map(row => ({ holder_key: `user:${row.holder_id}`, holder_id: row.holder_id, started_at: row.started_at })));
  const { rows: spending } = await database.query(`WITH scopes AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(holder_key text,started_at timestamptz)
    ), cash_payments AS MATERIALIZED (
      SELECT l.created_at,l.source_key,GREATEST(l.debit,0)+GREATEST(-l.credit,0) AS amount
      FROM ledger_entries l JOIN sites s ON s.id=l.site_id AND s.organization_id=$1
      WHERE l.site_id=$2 AND l.bucket='cash' AND l.entry_date<$4::date
        AND l.created_at>=(SELECT min(started_at) FROM scopes)
    ), by_source AS (
      SELECT r.holder_key,p.source_key,sum(p.amount) AS amount
      FROM scopes r JOIN cash_payments p ON p.created_at>=r.started_at
      WHERE p.source_key IS NOT NULL GROUP BY r.holder_key,p.source_key
    ) SELECT r.holder_key,
      COALESCE(sum(p.amount) FILTER(WHERE p.source_key IN ('plot_commission_payments','commission_payments')),0)::text AS commission,
      COALESCE(sum(p.amount) FILTER(WHERE p.source_key='expenses'),0)::text AS expenses,
      COALESCE(sum(p.amount) FILTER(WHERE p.source_key NOT IN ('plot_commission_payments','commission_payments','expenses')),0)::text AS other_cash_payments,
      COALESCE(jsonb_agg(jsonb_build_object('source',p.source_key,'amount',p.amount::text) ORDER BY p.source_key)
        FILTER (WHERE p.source_key IS NOT NULL AND p.amount <> 0), '[]'::jsonb) AS modules
    FROM scopes r LEFT JOIN by_source p ON p.holder_key=r.holder_key GROUP BY r.holder_key`, [organizationId, siteId, scopes, endDate]);
  const { rows: floats } = await database.query(`WITH scopes AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(holder_key text,holder_id integer,started_at timestamptz)
    ), accounts AS (
      SELECT r.holder_key,il.user_id,COALESCE(sum(il.amount),0) AS current_float,
        COALESCE(sum(il.amount) FILTER(WHERE il.created_at<r.started_at),0) AS opening_float
      FROM scopes r JOIN imprest_ledger il ON il.site_id=$2 AND il.created_at<$4::date
      JOIN sites s ON s.id=il.site_id AND s.organization_id=$1
      JOIN users u ON u.id=il.user_id AND LOWER(COALESCE(u.role,'')) NOT IN ('admin','super_admin')
      GROUP BY r.holder_key,il.user_id
    ), float_totals AS (
      SELECT holder_key,sum(GREATEST(current_float,0)-GREATEST(opening_float,0)) AS imprest
      FROM accounts GROUP BY holder_key
    ), given_totals AS (
      -- Gross cash given belongs to its giver, rather than every Admin wallet.
      -- Received allocations are authoritative for both handovers and approved
      -- refill requests; ledger expenses, returns and peer transfers are unrelated.
      SELECT r.holder_key,sum(a.amount) AS imprest_given
      FROM scopes r JOIN imprest_allocations a ON a.admin_id=r.holder_id AND a.site_id=$2
      JOIN sites s ON s.id=a.site_id AND s.organization_id=$1
      WHERE a.status='RECEIVED' AND a.from_own_float IS NOT TRUE AND a.amount>0
        AND COALESCE(a.confirmed_at,a.created_at)<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
      GROUP BY r.holder_key
    ) SELECT r.holder_key,COALESCE(f.imprest,0)::text AS imprest,
      COALESCE(g.imprest_given,0)::text AS imprest_given
      FROM scopes r LEFT JOIN float_totals f USING(holder_key)
      LEFT JOIN given_totals g USING(holder_key)`, [organizationId, siteId, scopes, endDate]);
  const spendByHolder = new Map(spending.map(row => [row.holder_key, row]));
  const floatByHolder = new Map(floats.map(row => [row.holder_key, row]));
  for (const opening of openings) {
    const key = `user:${opening.holder_id}`;
    const state = states.get(key);
    state.cash_deductions = walletCashDeductions({ opening, totals: totals.get(key), state,
      spending: spendByHolder.get(key), imprest: floatByHolder.get(key)?.imprest || '0', imprestGiven: floatByHolder.get(key)?.imprest_given || '0', siteId, holderId: opening.holder_id });
  }
  return states;
}
