import pool from '../../config/db.js';

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
const average = (values) => (values.length ? sum(values) / values.length : 0);
const standardDeviation = (values) => {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
};

const keyToIdx = (key) => {
  const [year, month] = String(key).split('-').map(Number);
  return year * 12 + month - 1;
};
const idxToKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
const monthLabel = (key) => {
  const idx = keyToIdx(key);
  return `${MONTHS_ABBR[idx % 12]} ${String(Math.floor(idx / 12) % 100).padStart(2, '0')}`;
};

const buildHorizon = (count, startKey) => {
  const start = keyToIdx(startKey);
  return Array.from({ length: count }, (_, index) => {
    const key = idxToKey(start + index);
    return { key, label: monthLabel(key) };
  });
};

// Complete historical months plus the current live month. Firm reconciliation
// rows are deliberately excluded from the predictive run-rate: they can move a
// balance, but they are not operating revenue/expense and would distort demand.
const HISTORICAL_SQL = `
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int),
      date_trunc('month', CURRENT_DATE),
      interval '1 month'
    )::date AS month
  ), movements AS (
    SELECT date_trunc('month', entry_date)::date AS month,
           COALESCE(SUM(credit), 0)::float8 AS inflow,
           COALESCE(SUM(debit), 0)::float8 AS outflow,
           COUNT(*)::int AS transactions
      FROM ledger_entries
     WHERE site_id = $1
       AND source_key <> 'firm_transactions'
       AND entry_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
       AND entry_date <= CURRENT_DATE
     GROUP BY 1
  )
  SELECT to_char(m.month, 'YYYY-MM') AS key,
         COALESCE(x.inflow, 0)::float8 AS inflow,
         COALESCE(x.outflow, 0)::float8 AS outflow,
         COALESCE(x.transactions, 0)::int AS transactions,
         (m.month = date_trunc('month', CURRENT_DATE)::date) AS is_current
    FROM months m
    LEFT JOIN movements x ON x.month = m.month
   ORDER BY m.month`;

// Pending installment inflow, recomputed using the same earmark-aware
// waterfall as the payment tracker. Stale paid_amount/status columns are not
// trusted. Overdue amounts are kept outside future month buckets.
const INFLOW_SQL = `
  WITH direct AS (
    SELECT pip.installment_id, SUM(pip.amount) AS direct_paid
      FROM plot_installment_payments pip
      JOIN plots p ON p.id = pip.plot_id
     WHERE p.site_id = $1
       AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY pip.installment_id
  ), generic AS (
    SELECT plot_id, SUM(amount) AS generic_pool FROM (
      SELECT pp.plot_id, pp.amount
        FROM plot_payments pp JOIN plots p ON p.id = pp.plot_id
       WHERE p.site_id = $1
         AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))
      UNION ALL
      SELECT pip.plot_id, pip.amount
        FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.installment_id IS NULL
         AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
    ) g GROUP BY plot_id
  ), schedule AS (
    SELECT pi.plot_id, pi.due_date,
           GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0)) AS need,
           SUM(GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0))) OVER (
             PARTITION BY pi.plot_id ORDER BY pi.sort_order, pi.due_date, pi.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_need
      FROM plot_installments pi
      JOIN plots p ON p.id = pi.plot_id
      LEFT JOIN direct d ON d.installment_id = pi.id
     WHERE p.site_id = $1
       AND p.status NOT IN ('CANCELLED','AVAILABLE','RESALE','TRANSFERRED')
  ), pending AS (
    SELECT s.due_date,
           GREATEST(0, LEAST(s.need, s.cumulative_need - COALESCE(g.generic_pool, 0))) AS remaining
      FROM schedule s LEFT JOIN generic g ON g.plot_id = s.plot_id
  )
  SELECT CASE WHEN due_date < CURRENT_DATE THEN 'OVERDUE'
              ELSE to_char(date_trunc('month', due_date), 'YYYY-MM') END AS bucket,
         SUM(remaining)::float8 AS amount
    FROM pending
   WHERE remaining > 0
     AND due_date < date_trunc('month', CURRENT_DATE) + make_interval(months => $2::int)
   GROUP BY 1`;

const VENDOR_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount
      FROM vendor_payments
     WHERE site_id = $1
       AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  )
  SELECT to_char(date_trunc('month', vc.due_date), 'YYYY-MM') AS month,
         SUM(vc.contract_amount - COALESCE(p.paid_amount, 0))::float8 AS amount
    FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
   WHERE vc.site_id = $1 AND vc.status = 'open' AND vc.due_date IS NOT NULL
     AND vc.due_date >= CURRENT_DATE
     AND vc.due_date < date_trunc('month', CURRENT_DATE) + make_interval(months => $2::int)
     AND vc.contract_amount - COALESCE(p.paid_amount, 0) > 0
   GROUP BY 1`;

const VENDOR_UNSCHEDULED_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1 AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  )
  SELECT COALESCE(SUM(GREATEST(0, vc.contract_amount - COALESCE(p.paid_amount, 0))), 0)::float8 AS amount
    FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
   WHERE vc.site_id = $1 AND vc.status = 'open' AND vc.due_date IS NULL`;

const VENDOR_OVERDUE_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1 AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  )
  SELECT COALESCE(SUM(GREATEST(0, vc.contract_amount - COALESCE(p.paid_amount, 0))), 0)::float8 AS amount
    FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
   WHERE vc.site_id = $1 AND vc.status = 'open'
     AND vc.due_date IS NOT NULL AND vc.due_date < CURRENT_DATE`;

const FARMER_SQL = `
  SELECT COALESCE(SUM(GREATEST(0, f.total_amount - COALESCE(pd.paid, 0))), 0)::float8 AS amount
    FROM farmers f
    LEFT JOIN (
      SELECT farmer_id, SUM(amount) AS paid FROM farmer_payments
       WHERE LOWER(COALESCE(status, 'approved')) = 'approved'
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       GROUP BY farmer_id
    ) pd ON pd.farmer_id = f.id
   WHERE f.site_id = $1 AND f.status = 'active'`;

const POSITION_SQL = `
  WITH imprest AS (
    SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS amount
      FROM (
        SELECT user_id, SUM(amount) AS user_balance
          FROM imprest_ledger
         WHERE site_id = $1 AND created_at::date <= CURRENT_DATE
         GROUP BY user_id
      ) balances
  )
  SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM') AS current_month,
         (
           ((date_trunc('month', CURRENT_DATE) + interval '1 month')::date - CURRENT_DATE)::float8
           / NULLIF(((date_trunc('month', CURRENT_DATE) + interval '1 month')::date
                     - date_trunc('month', CURRENT_DATE)::date)::float8, 0)
         ) AS remaining_month_fraction,
         (
           COALESCE((SELECT SUM(credit - debit) FROM ledger_entries
                      WHERE site_id = $1 AND entry_date <= CURRENT_DATE), 0)
           - imprest.amount
         )::float8 AS current_balance
    FROM imprest`;

const WEEKDAY_SQL = `
  SELECT EXTRACT(ISODOW FROM entry_date)::int AS weekday,
         COALESCE(SUM(credit), 0)::float8 AS inflow,
         COALESCE(SUM(debit), 0)::float8 AS outflow,
         COUNT(*)::int AS transactions
    FROM ledger_entries
   WHERE site_id = $1 AND source_key <> 'firm_transactions'
     AND entry_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
     AND entry_date <= CURRENT_DATE
   GROUP BY 1 ORDER BY 1`;

const SOURCE_SQL = `
  SELECT source_key AS source,
         COALESCE(SUM(credit), 0)::float8 AS inflow,
         COALESCE(SUM(debit), 0)::float8 AS outflow,
         COUNT(*)::int AS transactions
    FROM ledger_entries
   WHERE site_id = $1 AND source_key <> 'firm_transactions'
     AND entry_date >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2::int)
     AND entry_date <= CURRENT_DATE
   GROUP BY source_key
   ORDER BY SUM(credit + debit) DESC
   LIMIT 10`;

// Detailed known commitments for the module's action list. The aggregate
// forecast queries remain separate so limiting this list cannot change totals.
const DUE_ITEMS_SQL = `
  WITH direct AS (
    SELECT pip.installment_id, SUM(pip.amount) AS direct_paid
      FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id
     WHERE p.site_id = $1
       AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY pip.installment_id
  ), generic AS (
    SELECT plot_id, SUM(amount) AS generic_pool FROM (
      SELECT pp.plot_id, pp.amount FROM plot_payments pp JOIN plots p ON p.id = pp.plot_id
       WHERE p.site_id = $1 AND LOWER(COALESCE(pp.status, 'approved')) = 'approved'
         AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))
      UNION ALL
      SELECT pip.plot_id, pip.amount FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.installment_id IS NULL
         AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
    ) x GROUP BY plot_id
  ), schedule AS (
    SELECT pi.id, pi.plot_id, pi.installment_name, pi.due_date, p.plot_no, p.buyer_name,
           GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0)) AS need,
           SUM(GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0))) OVER (
             PARTITION BY pi.plot_id ORDER BY pi.sort_order, pi.due_date, pi.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_need
      FROM plot_installments pi JOIN plots p ON p.id = pi.plot_id
      LEFT JOIN direct d ON d.installment_id = pi.id
     WHERE p.site_id = $1 AND p.status NOT IN ('CANCELLED','AVAILABLE','RESALE','TRANSFERRED')
  ), installment_due AS (
    SELECT s.id, s.due_date,
           CONCAT('Plot ', COALESCE(s.plot_no, '—'), ' · ', COALESCE(s.buyer_name, 'Buyer')) AS entity,
           COALESCE(NULLIF(s.installment_name, ''), 'Plot installment') AS description,
           GREATEST(0, LEAST(s.need, s.cumulative_need - COALESCE(g.generic_pool, 0)))::float8 AS amount
      FROM schedule s LEFT JOIN generic g ON g.plot_id = s.plot_id
  ), vendor_paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1 AND LOWER(COALESCE(status, 'approved')) = 'approved'
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  ), farmer_paid AS (
    SELECT farmer_id, SUM(amount) AS paid_amount FROM farmer_payments
     WHERE LOWER(COALESCE(status, 'approved')) = 'approved'
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY farmer_id
  ), items AS (
    SELECT CONCAT('installment:', id) AS id, 'RECEIVABLE'::text AS type,
           'PLOT_INSTALLMENT'::text AS source, entity, description, due_date,
           amount,
           CASE WHEN due_date < CURRENT_DATE THEN 'OVERDUE' ELSE 'UPCOMING' END::text AS status
      FROM installment_due WHERE amount > 0
    UNION ALL
    SELECT CONCAT('vendor:', vc.id), 'PAYABLE', 'VENDOR_COMMITMENT',
           COALESCE(vc.vendor_name, 'Vendor'), COALESCE(NULLIF(vc.work_title, ''), 'Vendor commitment'),
           vc.due_date, (vc.contract_amount - COALESCE(vp.paid_amount, 0))::float8,
           CASE WHEN vc.due_date IS NULL THEN 'UNSCHEDULED'
                WHEN vc.due_date < CURRENT_DATE THEN 'OVERDUE' ELSE 'UPCOMING' END
      FROM vendor_commitments vc LEFT JOIN vendor_paid vp ON vp.commitment_id = vc.id
     WHERE vc.site_id = $1 AND vc.status = 'open'
       AND vc.contract_amount - COALESCE(vp.paid_amount, 0) > 0
    UNION ALL
    SELECT CONCAT('farmer:', f.id), 'PAYABLE', 'FARMER_OUTSTANDING',
           COALESCE(f.name, 'Land owner'), 'Land-owner outstanding', NULL::date,
           GREATEST(0, f.total_amount - COALESCE(fp.paid_amount, 0))::float8, 'UNSCHEDULED'
      FROM farmers f LEFT JOIN farmer_paid fp ON fp.farmer_id = f.id
     WHERE f.site_id = $1 AND f.status = 'active'
       AND f.total_amount - COALESCE(fp.paid_amount, 0) > 0
  )
  SELECT id, type, source, entity, description,
         CASE WHEN due_date IS NULL THEN NULL ELSE to_char(due_date, 'YYYY-MM-DD') END AS due_date,
         amount, status
    FROM items
   ORDER BY CASE status WHEN 'OVERDUE' THEN 0 WHEN 'UPCOMING' THEN 1 ELSE 2 END,
            due_date NULLS LAST, amount DESC
   LIMIT 100`;

const SOURCE_LABELS = {
  plot_payments: 'Plot payments',
  plot_installment_payments: 'Installments',
  farmer_payments: 'Farmer payments',
  plot_commission_payments: 'Commissions',
  vendor_payments: 'Vendor payments',
  expenses: 'Expenses',
  day_book: 'Day Book',
  personal_ledger: 'Personal ledgers',
  cash_flow_entries: 'Personal ledgers',
};

const weightedAverage = (values) => {
  if (!values.length) return 0;
  const weightTotal = values.reduce((total, _, index) => total + index + 1, 0);
  return values.reduce((total, value, index) => total + value * (index + 1), 0) / weightTotal;
};

const regressionSlope = (values) => {
  if (values.length < 2) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY = average(values);
  const numerator = values.reduce((total, value, index) => total + (index - meanX) * (value - meanY), 0);
  const denominator = values.reduce((total, _, index) => total + (index - meanX) ** 2, 0);
  return denominator ? numerator / denominator : 0;
};

const seriesModel = (history, field) => {
  const values = history.map((row) => Number(row[field]) || 0);
  const mean = average(values);
  const weighted = weightedAverage(values);
  const rawSlope = regressionSlope(values);
  const slopeLimit = mean > 0 ? mean * 0.18 : 0;
  const slope = clamp(rawSlope, -slopeLimit, slopeLimit);
  const deviation = standardDeviation(values);
  return {
    values,
    mean,
    weighted,
    slope,
    deviation,
    volatility: mean > 0 ? (deviation / mean) * 100 : 0,
    activeMonths: values.filter((value) => value > 0).length,
  };
};

const seasonalFactor = (history, field, targetKey) => {
  if (history.length < 12) return 1;
  const overall = average(history.map((row) => Number(row[field]) || 0));
  if (overall <= 0) return 1;
  const targetMonth = Number(targetKey.slice(5, 7));
  const matching = history
    .filter((row) => Number(row.key.slice(5, 7)) === targetMonth)
    .map((row) => Number(row[field]) || 0);
  if (!matching.length) return 1;
  const raw = average(matching) / overall;
  // Seasonal evidence is intentionally shrunk toward 1.0 because a 12–24
  // month accounting history rarely supports an aggressive seasonal claim.
  return clamp(1 + (raw - 1) * 0.35, 0.8, 1.2);
};

const predictBaseline = (model, history, field, targetKey, step) => {
  if (model.mean <= 0 && model.weighted <= 0) return 0;
  const trendValue = model.weighted + model.slope * (step + 1) * 0.7;
  const bounded = clamp(trendValue, model.mean * 0.45, model.mean * 1.75);
  return round2(Math.max(0, bounded * seasonalFactor(history, field, targetKey)));
};

const trendLabel = (percent) => (percent > 3 ? 'RISING' : percent < -3 ? 'FALLING' : 'STABLE');
const scenarioTotals = (months, prefix = '') => {
  const field = (name) => prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name;
  const inflow = sum(months.map((month) => month[field('inflow')]));
  const outflow = sum(months.map((month) => month[field('outflow')]));
  return { inflow: round2(inflow), outflow: round2(outflow), net: round2(inflow - outflow) };
};

export async function getFinanceForecast(siteId, { horizonMonths = 6, lookbackMonths = 12 } = {}) {
  const horizon = clamp(Number.parseInt(horizonMonths, 10) || 6, 1, 18);
  const lookback = clamp(Number.parseInt(lookbackMonths, 10) || 12, 3, 24);

  const [
    positionRes, historicalRes, inflowRes, vendorRes, vendorUnscheduledRes,
    vendorOverdueRes, farmerRes, weekdayRes, sourceRes, dueItemsRes,
  ] = await Promise.all([
    pool.query(POSITION_SQL, [siteId]),
    pool.query(HISTORICAL_SQL, [siteId, lookback]),
    pool.query(INFLOW_SQL, [siteId, horizon]),
    pool.query(VENDOR_SQL, [siteId, horizon]),
    pool.query(VENDOR_UNSCHEDULED_SQL, [siteId]),
    pool.query(VENDOR_OVERDUE_SQL, [siteId]),
    pool.query(FARMER_SQL, [siteId]),
    pool.query(WEEKDAY_SQL, [siteId, lookback]),
    pool.query(SOURCE_SQL, [siteId, lookback]),
    pool.query(DUE_ITEMS_SQL, [siteId]),
  ]);

  const position = positionRes.rows[0];
  const currentBalance = round2(position?.current_balance || 0);
  const remainingMonthFraction = clamp(Number(position?.remaining_month_fraction) || 1, 0.03, 1);
  const historical = historicalRes.rows.map((row) => ({
    key: row.key,
    label: monthLabel(row.key),
    inflow: round2(row.inflow),
    outflow: round2(row.outflow),
    net: round2(Number(row.inflow) - Number(row.outflow)),
    transactions: Number(row.transactions) || 0,
    isCurrent: Boolean(row.is_current),
  }));
  const completeHistory = historical.filter((row) => !row.isCurrent);
  const inflowModel = seriesModel(completeHistory, 'inflow');
  const outflowModel = seriesModel(completeHistory, 'outflow');
  const netDeviation = standardDeviation(completeHistory.map((row) => row.net));

  const inflowByMonth = {};
  let overdueReceivables = 0;
  inflowRes.rows.forEach((row) => {
    if (row.bucket === 'OVERDUE') overdueReceivables = Number(row.amount) || 0;
    else inflowByMonth[row.bucket] = Number(row.amount) || 0;
  });
  const vendorByMonth = Object.fromEntries(vendorRes.rows.map((row) => [row.month, Number(row.amount) || 0]));

  let baseBalance = currentBalance;
  let conservativeBalance = currentBalance;
  let optimisticBalance = currentBalance;
  const forecast = buildHorizon(horizon, position.current_month).map((month, index) => {
    const monthFraction = index === 0 ? remainingMonthFraction : 1;
    const predictedInflow = round2(
      predictBaseline(inflowModel, completeHistory, 'inflow', month.key, index) * monthFraction,
    );
    const predictedOutflow = round2(
      predictBaseline(outflowModel, completeHistory, 'outflow', month.key, index) * monthFraction,
    );
    const scheduledInflow = round2(inflowByMonth[month.key] || 0);
    const scheduledOutflow = round2(vendorByMonth[month.key] || 0);

    const inflow = round2(Math.max(predictedInflow, scheduledInflow));
    const outflow = round2(Math.max(predictedOutflow, scheduledOutflow));
    const conservativeInflow = round2(Math.max(predictedInflow * 0.82, scheduledInflow * 0.85));
    const conservativeOutflow = round2(Math.max(predictedOutflow * 1.15, scheduledOutflow));
    const optimisticInflow = round2(Math.max(predictedInflow * 1.12, scheduledInflow));
    const optimisticOutflow = round2(Math.max(predictedOutflow * 0.9, scheduledOutflow * 0.95));
    const net = round2(inflow - outflow);
    const conservativeNet = round2(conservativeInflow - conservativeOutflow);
    const optimisticNet = round2(optimisticInflow - optimisticOutflow);
    const uncertainty = Math.max(netDeviation * Math.sqrt(monthFraction), Math.abs(net) * 0.08)
      * Math.sqrt(1 + index / 8);

    baseBalance = round2(baseBalance + net);
    conservativeBalance = round2(conservativeBalance + conservativeNet);
    optimisticBalance = round2(optimisticBalance + optimisticNet);

    return {
      ...month,
      predictedInflow,
      predictedOutflow,
      scheduledInflow,
      scheduledOutflow,
      inflow,
      outflow,
      net,
      conservativeInflow,
      conservativeOutflow,
      conservativeNet,
      optimisticInflow,
      optimisticOutflow,
      optimisticNet,
      lowerNet: round2(net - uncertainty),
      upperNet: round2(net + uncertainty),
      baseClosingBalance: baseBalance,
      conservativeClosingBalance: conservativeBalance,
      optimisticClosingBalance: optimisticBalance,
    };
  });

  const inflowTrendPercent = inflowModel.mean > 0 ? clamp((inflowModel.slope / inflowModel.mean) * 100, -100, 100) : 0;
  const outflowTrendPercent = outflowModel.mean > 0 ? clamp((outflowModel.slope / outflowModel.mean) * 100, -100, 100) : 0;
  const activeRatio = completeHistory.length
    ? (inflowModel.activeMonths + outflowModel.activeMonths) / (completeHistory.length * 2)
    : 0;
  const averageVolatility = (inflowModel.volatility + outflowModel.volatility) / 2;
  const confidenceScore = Math.round(clamp(
    30 + Math.min(completeHistory.length / 12, 1) * 35 + activeRatio * 25 - Math.min(averageVolatility, 180) / 12,
    18,
    94,
  ));
  const confidenceLevel = confidenceScore >= 75 ? 'HIGH' : confidenceScore >= 52 ? 'MEDIUM' : 'LOW';

  const weekdayMap = new Map(weekdayRes.rows.map((row) => [Number(row.weekday), row]));
  const weekdayPattern = WEEKDAYS.map((label, index) => {
    const row = weekdayMap.get(index + 1) || {};
    return {
      weekday: index + 1,
      label,
      inflow: round2(row.inflow),
      outflow: round2(row.outflow),
      transactions: Number(row.transactions) || 0,
    };
  });

  const sourcePattern = sourceRes.rows.map((row) => ({
    source: row.source,
    label: SOURCE_LABELS[row.source] || String(row.source || 'Other').replaceAll('_', ' '),
    inflow: round2(row.inflow),
    outflow: round2(row.outflow),
    transactions: Number(row.transactions) || 0,
  }));

  const totals = {
    base: scenarioTotals(forecast),
    conservative: scenarioTotals(forecast, 'conservative'),
    optimistic: scenarioTotals(forecast, 'optimistic'),
  };
  const baseBalances = forecast.map((month) => month.baseClosingBalance);
  const conservativeBalances = forecast.map((month) => month.conservativeClosingBalance);
  const lowestBalance = baseBalances.length ? Math.min(...baseBalances) : currentBalance;
  const lowestConservativeBalance = conservativeBalances.length ? Math.min(...conservativeBalances) : currentBalance;
  const deficitMonths = baseBalances.filter((balance) => balance < 0).length;
  const firstDeficit = forecast.find((month) => month.baseClosingBalance < 0);
  const riskLevel = lowestConservativeBalance < 0 || deficitMonths > 0
    ? 'HIGH'
    : totals.base.net < 0 || lowestConservativeBalance < currentBalance * 0.2
      ? 'MEDIUM'
      : 'LOW';
  const summary = firstDeficit
    ? `Cash may turn negative in ${firstDeficit.label}; prioritize overdue recovery and reschedule non-critical payables.`
    : totals.base.net < 0
      ? 'The forecast remains funded, but projected outflow is above inflow across the selected horizon.'
      : 'Projected collections cover expected payments across the selected horizon under the base scenario.';

  return {
    currentBalance,
    historical,
    forecast,
    totals,
    runRate: {
      lookbackMonths: lookback,
      inflowPerMonth: round2(inflowModel.weighted),
      outflowPerMonth: round2(outflowModel.weighted),
    },
    analytics: {
      method: 'Recency-weighted trend + restrained seasonality + known dues',
      version: '2.0',
      confidenceScore,
      confidenceLevel,
      historicalMonths: completeHistory.length,
      activeMonths: Math.max(inflowModel.activeMonths, outflowModel.activeMonths),
      transactionCount: sum(historical.map((row) => row.transactions)),
      inflowTrendPercent: round2(inflowTrendPercent),
      outflowTrendPercent: round2(outflowTrendPercent),
      inflowTrend: trendLabel(inflowTrendPercent),
      outflowTrend: trendLabel(outflowTrendPercent),
      inflowVolatility: round2(inflowModel.volatility),
      outflowVolatility: round2(outflowModel.volatility),
    },
    context: {
      overdueReceivables: round2(overdueReceivables),
      vendorOverdue: round2(vendorOverdueRes.rows[0]?.amount || 0),
      vendorUnscheduled: round2(vendorUnscheduledRes.rows[0]?.amount || 0),
      farmerOutstanding: round2(farmerRes.rows[0]?.amount || 0),
    },
    risk: {
      level: riskLevel,
      summary,
      lowestBalance: round2(lowestBalance),
      lowestConservativeBalance: round2(lowestConservativeBalance),
      deficitMonths,
      firstDeficitMonth: firstDeficit?.key || null,
    },
    weekdayPattern,
    sourcePattern,
    dueItems: dueItemsRes.rows.map((row) => ({
      id: row.id,
      type: row.type,
      source: row.source,
      entity: row.entity,
      description: row.description,
      dueDate: row.due_date,
      amount: round2(row.amount),
      status: row.status,
    })),
    horizonMonths: horizon,
    generatedAt: new Date().toISOString(),
    refreshAfterSeconds: 60,
  };
}
