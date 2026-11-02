const paise = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? '').trim());
  if (!match) throw new Error('Invalid wallet reconciliation amount');
  return (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0'))) * (match[1] ? -1n : 1n);
};
const money = value => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
const validMoney=value=>/^-?\d+(?:\.\d{1,2})?$/.test(String(value??''));

export function walletCashDeductions({ opening, totals, state, spending, imprest='0', imprestGiven='0', pendingCashCommitments='0', siteId, holderId }) {
  const received = paise(opening.opening_cash) + paise(totals.total_received) - paise(opening.received_at_start);
  const handed = paise(totals.total_handover) - paise(opening.handovers_at_start);
  const current = paise(state.balance),commission=paise(spending.commission),expenses=paise(spending.expenses);
  const otherPayments=paise(spending.other_cash_payments),float=paise(imprest),given=paise(imprestGiven??'0');
  if(given<0n) throw new Error('Gross imprest given cannot be negative');
  const payments=commission+expenses+otherPayments,total=received-handed-current;
  const adjustment=current-(received-handed-payments-given);
  const commitments=paise(pendingCashCommitments);
  if(commitments<0n) throw new Error('Pending cash commitments cannot be negative');
  const corrections=validMoney(totals.total_adjustments)&&validMoney(opening.adjustments_at_start??'0')
    ? paise(totals.total_adjustments)-paise(opening.adjustments_at_start??'0') : null;
  const bridge=validMoney(totals.total_imprest_out)&&validMoney(opening.imprest_out_at_start??'0')
    ? paise(totals.total_imprest_out)-paise(opening.imprest_out_at_start??'0') : null;
  const recordedCustody=state.cash_in_hand_basis!=='SITE_CASH_AFTER_IMPREST'&&corrections!==null&&bridge!==null
    &&received-handed-bridge+corrections===current&&given>=bridge;
  const outsidePayments=recordedCustody?payments:0n,outsideGiving=recordedCustody?given-bridge:0n;
  return {version:2,scope:'holder',site_id:Number(siteId),holder_id:Number(holderId),started_at:opening.started_at??null,
    // Carry the verified opening in the same snapshot as its activity totals.
    // Explicit null means all history; clients must retain their legacy API
    // fallback when this metadata marker is absent or does not validate.
    opening_metadata_version:1,reporting_opening:opening.version===1?opening:null,
    received:money(received),handed_over:money(handed),current_cash:money(current),
    commission:money(commission),expenses:money(expenses),other_cash_payments:money(otherPayments),payment_total:money(payments),
    imprest_given:money(given),imprest:money(float),
    ...(Array.isArray(spending.modules)?{modules:spending.modules}:{}),
    // Physical cash remains authoritative. Returns, earlier floats, edits and
    // custody changes never become the holder's expenses.
    cash_adjustment:money(adjustment),
    ...(corrections===null?{}:{reconciliation:{wallet_corrections:money(corrections),pending_cash_commitments:money(-commitments),
      ...(outsidePayments||outsideGiving?{module_activity_outside_wallet:money(outsidePayments),imprest_activity_outside_wallet:money(outsideGiving)}:{}),
      other_cash_changes:money(adjustment-corrections+commitments-outsidePayments-outsideGiving)}}),
    other_adjustments:money(total-payments-float),total:money(total)};
}

// ledger_entries owns the posted amount, sign and cash/bank policy. Its ID is
// the canonical CFE ID, with :cash/:bank on split legs. CFE.created_by retains
// the immutable original maker, including staff expenses approved by Admin.
// Reuse this CTE for the table aggregate and paginated deductions detail.
// Callers supply scopes(holder_key,holder_id,started_at), $1 org, $2 site,
// $3 scopes JSON and $4 exclusive India business-date cutoff.
export const holderCashPaymentsCte = `holder_cash_payments AS MATERIALIZED (
  SELECT r.holder_key,l.*,c.created_by AS maker_id,
    GREATEST(l.debit,0)+GREATEST(-l.credit,0) AS payment_amount
  FROM scopes r JOIN ledger_entries l ON l.site_id=$2 AND l.bucket='cash'
    AND l.created_at>=COALESCE(r.started_at,'1900-01-01'::timestamptz)
    AND l.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata') AND l.entry_date<$4::date
  JOIN sites s ON s.id=l.site_id AND s.organization_id=$1
  JOIN cash_flow_entries c ON c.id=NULLIF(split_part(l.id::text,':',1),'')::integer
    AND c.site_id=l.site_id AND c.created_by=r.holder_id
  WHERE GREATEST(l.debit,0)+GREATEST(-l.credit,0)>0
    AND NOT EXISTS (
      SELECT 1 FROM imprest_ledger il WHERE il.user_id=r.holder_id AND il.site_id=$2
        AND il.type='EXPENSE' AND il.amount<0 AND il.reference_id=COALESCE(c.source_id,c.id)
        AND il.source_module=CASE COALESCE(NULLIF(c.source_module,''),'cash_flow_entries')
          WHEN 'cash_flow_entries' THEN 'cash_flow_entry' WHEN 'personal_ledger' THEN 'cash_flow_entry'
          WHEN 'expenses' THEN 'expense' WHEN 'farmer_payments' THEN 'farmer_payment'
          WHEN 'plot_commissions' THEN 'plot_commission' WHEN 'plot_commission_payments' THEN 'plot_commission_payment'
          WHEN 'vendor_payments' THEN 'vendor_payment' WHEN 'vendor_inventory_payments' THEN 'vendor_inventory_payment'
          WHEN 'firm_transactions' THEN 'firm_transaction' WHEN 'misc_income_entries' THEN 'misc_income_entry'
          WHEN 'plot_payments' THEN 'plot_payment' WHEN 'plot_installment_payments' THEN 'plot_installment_payment'
          WHEN 'land_deal_payments' THEN 'land_deal_payment' WHEN 'partner_profit_payments' THEN 'partner_profit_payment'
          WHEN 'day_book' THEN 'daybook'
          ELSE c.source_module END
    )
)`;

// The combined workspace embeds this exact query; standalone reads retain
// the same parameterized statement and financial rules.
export const walletHolderActivitySql=`WITH scopes AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(holder_key text,holder_id integer,started_at timestamptz)
  ), ${holderCashPaymentsCte}, by_source AS (
    SELECT holder_key,source_key,sum(payment_amount) AS amount FROM holder_cash_payments GROUP BY holder_key,source_key
  ), spending AS (SELECT r.holder_key,
    COALESCE(sum(p.amount) FILTER(WHERE p.source_key IN ('plot_commission_payments','commission_payments')),0)::text AS commission,
    COALESCE(sum(p.amount) FILTER(WHERE p.source_key='expenses'),0)::text AS expenses,
    COALESCE(sum(p.amount) FILTER(WHERE p.source_key NOT IN ('plot_commission_payments','commission_payments','expenses')),0)::text AS other_cash_payments,
    COALESCE(jsonb_agg(jsonb_build_object('source',p.source_key,'amount',p.amount::text) ORDER BY p.source_key)
      FILTER(WHERE p.source_key IS NOT NULL AND p.amount<>0),'[]'::jsonb) AS modules
    FROM scopes r LEFT JOIN by_source p USING(holder_key) GROUP BY r.holder_key), given_rows AS (
    SELECT r.holder_key,a.amount FROM scopes r JOIN imprest_allocations a ON a.admin_id=r.holder_id AND a.site_id=$2
      JOIN sites s ON s.id=a.site_id AND s.organization_id=$1
      WHERE a.status='RECEIVED' AND a.amount>0
        AND COALESCE(a.confirmed_at,a.created_at)>=COALESCE(r.started_at,'1900-01-01'::timestamptz)
        AND COALESCE(a.confirmed_at,a.created_at)<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    UNION ALL
    -- Legacy immediate transfers have their own committed audit record and
    -- ledger pair, not an allocation. Count each source-giver record once.
    SELECT r.holder_key,t.amount FROM scopes r JOIN imprest_transfers t
      ON t.from_user_id=r.holder_id AND t.site_id=$2
      JOIN sites s ON s.id=t.site_id AND s.organization_id=$1
      WHERE t.amount>0 AND t.created_at>=COALESCE(r.started_at,'1900-01-01'::timestamptz)
        AND t.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    UNION ALL
    SELECT r.holder_key,-e.amount FROM scopes r JOIN loyalty_vault_entries e
      ON e.organization_id=$1 AND e.site_id=$2 AND e.holder_key=r.holder_key AND e.kind='imprest_out' AND e.amount<0
      AND e.created_at>=COALESCE(r.started_at,'1900-01-01'::timestamptz)
      AND e.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  ), giving AS (
    SELECT holder_key,sum(amount) AS amount FROM given_rows GROUP BY holder_key
  ), pending_rows AS (
    SELECT r.holder_key,a.amount FROM scopes r JOIN imprest_allocations a ON a.site_id=$2
      JOIN sites s ON s.id=a.site_id AND s.organization_id=$1
      WHERE a.status='PENDING_RECEIPT' AND a.from_own_float=false
        AND a.created_at>=COALESCE(r.started_at,'1900-01-01'::timestamptz)
        AND a.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    UNION ALL
    SELECT r.holder_key,c.amount FROM scopes r JOIN imprest_site_debit_reservations c ON c.site_id=$2
      JOIN sites s ON s.id=c.site_id AND s.organization_id=$1
      WHERE c.created_at>=COALESCE(r.started_at,'1900-01-01'::timestamptz)
        AND c.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
  ), commitments AS (SELECT holder_key,sum(amount) AS amount FROM pending_rows GROUP BY holder_key),
  net_scopes AS (
    SELECT * FROM jsonb_to_recordset($5::jsonb) AS r(holder_key text,started_at timestamptz)
  ), float_accounts AS (
    SELECT r.holder_key,il.user_id,COALESCE(sum(il.amount),0) AS current_float,
      COALESCE(sum(il.amount) FILTER(WHERE il.created_at<r.started_at),0) AS opening_float
    FROM net_scopes r JOIN imprest_ledger il ON il.site_id=$2
      AND il.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    JOIN sites s ON s.id=il.site_id AND s.organization_id=$1
    JOIN users u ON u.id=il.user_id AND LOWER(COALESCE(u.role,'')) NOT IN ('admin','super_admin')
    GROUP BY r.holder_key,il.user_id
  ), floats AS (
    SELECT holder_key,sum(GREATEST(current_float,0)-GREATEST(opening_float,0)) AS imprest FROM float_accounts GROUP BY holder_key
  ), other_funding AS (
    SELECT r.holder_key,-COALESCE(sum(e.amount),0) AS amount FROM net_scopes r LEFT JOIN loyalty_vault_entries e
      ON e.organization_id=$1 AND e.site_id=$2 AND e.kind='imprest_out' AND e.holder_key<>r.holder_key
      AND e.created_at>=r.started_at AND e.created_at<($4::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    GROUP BY r.holder_key
  ) SELECT p.*,COALESCE(g.amount,0)::text AS imprest_given,COALESCE(c.amount,0)::text AS pending_cash_commitments,
    (COALESCE(f.imprest,0)-COALESCE(w.amount,0))::text AS imprest
    FROM spending p LEFT JOIN giving g USING(holder_key) LEFT JOIN commitments c USING(holder_key)
      LEFT JOIN floats f USING(holder_key) LEFT JOIN other_funding w USING(holder_key)`;

async function readActivity(database,{organizationId,siteId,scopes,endDate,net=false,netScopes}) {
  const params=[organizationId,siteId,JSON.stringify(scopes),endDate,JSON.stringify(net?(netScopes||scopes):[])];
  const {rows:activity}=await database.query(walletHolderActivitySql,params);
  return walletHolderActivityFromRows(activity);
}

export function walletHolderActivityFromRows(activity) {

  return {spending:new Map(activity.map(row=>[row.holder_key,row])),given:new Map(activity.map(row=>[row.holder_key,row.imprest_given])),
    commitments:new Map(activity.map(row=>[row.holder_key,row.pending_cash_commitments])),
    net:new Map(activity.map(row=>[row.holder_key,row.imprest]))};
}

async function activityContextFor(database,{organizationId,siteId,endDate}) {
  // Read the opening metadata and database business-date cutoff together. This
  // clock remains in the caller's snapshot, including sites without openings.
  const {rows}=await database.query(`SELECT a.setting_value,clock.end_date FROM
    (SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS end_date) clock
    LEFT JOIN application_settings a ON a.site_id=$2 AND a.setting_key LIKE 'wallet_reporting_opening:user:%'
      AND EXISTS(SELECT 1 FROM sites s WHERE s.id=a.site_id AND s.organization_id=$1)`,[organizationId,siteId]);
  return walletActivityContextFromRows(rows,{organizationId,siteId,endDate});
}

export function walletActivityContextFromRows(rows,{organizationId,siteId,endDate}) {
  const openings=rows.map(row=>row.setting_value).filter(row=>row?.version===1&&row.holder_type==='user'
    &&row.organization_id===Number(organizationId)&&row.site_id===Number(siteId)&&Number.isSafeInteger(row.holder_id)
    &&Number.isFinite(Date.parse(row.started_at))&&typeof row.operation_key==='string'&&!!row.operation_key
    &&['opening_cash','received_at_start','handovers_at_start','adjustments_at_start','recorded_balance_at_start'].every(key=>validMoney(row[key])));
  return {openings,endDate:endDate||rows[0].end_date};
}

// Aligned Admin balances retain their existing physical cash projection. The
// activity columns describe only that Admin's own transactions and gross giving.
export async function addWalletCashDeductions(database,{organizationId,siteId,states,totals,endDate}) {
  if(!states.size) return states;
  const context=await activityContextFor(database,{organizationId,siteId,endDate});
  const openings=context.openings.filter(row=>states.has(`user:${row.holder_id}`));
  if(!openings.length) return states;
  const activity=await readActivity(database,{organizationId,siteId,endDate:context.endDate,net:true,
    scopes:openings.map(row=>({holder_key:`user:${row.holder_id}`,holder_id:row.holder_id,started_at:row.started_at}))});
  for(const opening of openings) {
    const key=`user:${opening.holder_id}`,state=states.get(key);
    state.cash_deductions=walletCashDeductions({opening,totals:totals.get(key),state,spending:activity.spending.get(key),
      imprest:activity.net.get(key)||'0',imprestGiven:activity.given.get(key)||'0',pendingCashCommitments:activity.commitments.get(key)||'0',siteId,holderId:opening.holder_id});
  }
  return states;
}

// Batch ordinary visible wallets without changing balances or source postings.
// No opening means all recorded history and a null started_at. Private rows
// never gain money through this enrichment.
export async function addHolderWalletActivity(database,{organizationId,siteId,holders,endDate,includeAlignedNet=false,preloadedActivity}) {
  const rows=holders.filter(row=>(row.holder_type??'user')==='user'&&row.balance!=null
    &&Number.isSafeInteger(Number(row.holder_id??row.id))&&Number(row.holder_id??row.id)>0
    &&!(row.cash_deductions?.version===2&&row.cash_deductions.scope==='holder'
      &&Number(row.cash_deductions.site_id)===Number(siteId)&&Number(row.cash_deductions.holder_id)===Number(row.holder_id??row.id)
      &&row.cash_deductions.current_cash===money(paise(row.balance))));
  if(!rows.length) return holders;
  const context=preloadedActivity?.context??await activityContextFor(database,{organizationId,siteId,endDate});
  const saved=new Map(context.openings.map(row=>[row.holder_id,row]));
  const scopes=rows.map(row=>({holder_key:`user:${row.holder_id??row.id}`,holder_id:Number(row.holder_id??row.id),started_at:saved.get(Number(row.holder_id??row.id))?.started_at??null}));
  const aligned=new Set(rows.filter(row=>row.cash_in_hand_basis==='SITE_CASH_AFTER_IMPREST').map(row=>Number(row.holder_id??row.id)));
  const netScopes=includeAlignedNet?scopes.filter(scope=>aligned.has(scope.holder_id)&&saved.has(scope.holder_id)):[];
  // Metadata with unusual legacy dates remains supported: use embedded results
  // only when its SQL-derived scopes exactly match the established JS rules.
  const signature=list=>JSON.stringify((list||[]).map(row=>[row.holder_key,row.holder_id??null,row.started_at??null]).sort((a,b)=>a[0].localeCompare(b[0])));
  const compatible=preloadedActivity&&signature(preloadedActivity.scopes)===signature(scopes)
    &&signature(preloadedActivity.netScopes)===signature(netScopes);
  const activity=compatible?walletHolderActivityFromRows(preloadedActivity.rows):await readActivity(database,{organizationId,siteId,scopes,endDate:context.endDate,net:netScopes.length>0,netScopes});
  for(const row of rows) {
    const holderId=Number(row.holder_id??row.id),key=`user:${holderId}`;
    const opening=saved.get(holderId)||{opening_cash:'0',received_at_start:'0',handovers_at_start:'0',started_at:null};
    if(![row.total_received,row.total_handover,row.balance].every(validMoney)) continue;
    row.cash_deductions=walletCashDeductions({opening,totals:row,state:row,spending:activity.spending.get(key),
      imprest:activity.net.get(key)||'0',imprestGiven:activity.given.get(key)||'0',
      pendingCashCommitments:aligned.has(holderId)?activity.commitments.get(key)||'0':'0',siteId,holderId});
  }
  return holders;
}
