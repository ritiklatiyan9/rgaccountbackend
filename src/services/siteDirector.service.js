import pool from '../config/db.js';

export const SITE_DIRECTOR_MODULE_LABELS = {
  personal_ledger: 'Personal Ledger',
  cash_flow_entries: 'Personal Ledger',
  farmer_payments: 'Farmer Payments',
  plot_commission_payments: 'Plot Commission',
  plot_commissions: 'Plot Commission',
  plot_payments: 'Plot Payments',
  plot_installment_payments: 'Plot Installments',
  expenses: 'Expenses',
  vendor_payments: 'Vendor Payments',
  firm_transactions: 'Firm Transactions',
  day_book: 'Day Book',
};

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;
const valueOf = (value) => Number(value) || 0;

const isoDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const DIRECTOR_PERIODS = new Set(['day', 'week', 'month', 'quarter', 'year', 'overall']);

const directorPeriodRange = (requestedPreset) => {
  const preset = DIRECTOR_PERIODS.has(requestedPreset) ? requestedPreset : 'overall';
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dateTo = isoDate(from);

  if (preset === 'overall') {
    return { preset, label: 'Overall', dateFrom: null, dateTo };
  }
  if (preset === 'day') {
    return { preset, label: 'Today', dateFrom: dateTo, dateTo };
  }
  if (preset === 'week') {
    const weekday = from.getDay() || 7;
    from.setDate(from.getDate() - weekday + 1);
  } else if (preset === 'month') {
    from.setDate(1);
  } else if (preset === 'quarter') {
    from.setMonth(Math.floor(from.getMonth() / 3) * 3, 1);
  } else if (preset === 'year') {
    from.setMonth(0, 1);
  }

  const labels = {
    week: 'This week',
    month: 'This month',
    quarter: 'This quarter',
    year: 'This year',
  };
  return { preset, label: labels[preset], dateFrom: isoDate(from), dateTo };
};

export const normalizeDirectorSource = (source) => {
  const normalized = String(source || 'personal_ledger').replace(/_person$/i, '');
  return normalized === 'cash_flow_entries' ? 'personal_ledger' : normalized;
};

const sourceLabel = (source) => (
  SITE_DIRECTOR_MODULE_LABELS[source]
  || String(source || 'Personal Ledger')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
);

const OVERVIEW_SQL = `
  WITH movement AS (
    SELECT
      site_id,
      COALESCE(SUM(credit - debit) FILTER (WHERE bucket = 'cash'), 0)::numeric AS cash_book,
      COALESCE(SUM(credit - debit) FILTER (WHERE bucket <> 'cash'), 0)::numeric AS bank_balance,
      COALESCE(SUM(credit), 0)::numeric AS total_inflow,
      COALESCE(SUM(debit), 0)::numeric AS total_outflow,
      COUNT(*)::int AS transaction_count
    FROM ledger_entries
    WHERE entry_date <= $2::date
      AND source_key !~ '_person$'
    GROUP BY site_id
  ),
  period_movement AS (
    SELECT
      site_id,
      COALESCE(SUM(credit) FILTER (WHERE bucket = 'cash'), 0)::numeric AS cash_in,
      COALESCE(SUM(debit) FILTER (WHERE bucket = 'cash'), 0)::numeric AS cash_out,
      COALESCE(SUM(credit) FILTER (WHERE bucket <> 'cash'), 0)::numeric AS bank_in,
      COALESCE(SUM(debit) FILTER (WHERE bucket <> 'cash'), 0)::numeric AS bank_out,
      COUNT(*)::int AS period_transaction_count
    FROM ledger_entries
    WHERE ($1::date IS NULL OR entry_date >= $1::date)
      AND entry_date <= $2::date
      AND source_key !~ '_person$'
    GROUP BY site_id
  ),
  month_movement AS (
    SELECT
      site_id,
      COALESCE(SUM(credit), 0)::numeric AS month_inflow,
      COALESCE(SUM(debit), 0)::numeric AS month_outflow
    FROM ledger_entries
    WHERE entry_date >= date_trunc('month', CURRENT_DATE)
      AND entry_date <= CURRENT_DATE
      AND source_key !~ '_person$'
    GROUP BY site_id
  ),
  imprest AS (
    SELECT site_id, COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS imprest_float
    FROM (
      SELECT site_id, user_id, SUM(amount) AS user_balance
      FROM imprest_ledger
      WHERE site_id IS NOT NULL AND created_at::date <= $2::date
      GROUP BY site_id, user_id
    ) balances
    GROUP BY site_id
  )
  SELECT
    s.id,
    s.name,
    s.code,
    s.city,
    s.state,
    s.status,
    COALESCE(m.cash_book, 0)::float8 AS cash_book,
    COALESCE(i.imprest_float, 0)::float8 AS imprest_float,
    (COALESCE(m.cash_book, 0) - COALESCE(i.imprest_float, 0))::float8 AS cash_balance,
    COALESCE(m.bank_balance, 0)::float8 AS bank_balance,
    (
      COALESCE(m.cash_book, 0)
      + COALESCE(m.bank_balance, 0)
      - COALESCE(i.imprest_float, 0)
    )::float8 AS total_balance,
    COALESCE(m.total_inflow, 0)::float8 AS total_inflow,
    COALESCE(m.total_outflow, 0)::float8 AS total_outflow,
    COALESCE(mm.month_inflow, 0)::float8 AS month_inflow,
    COALESCE(mm.month_outflow, 0)::float8 AS month_outflow,
    COALESCE(m.transaction_count, 0)::int AS transaction_count,
    COALESCE(pm.cash_in, 0)::float8 AS cash_in,
    COALESCE(pm.cash_out, 0)::float8 AS cash_out,
    COALESCE(pm.bank_in, 0)::float8 AS bank_in,
    COALESCE(pm.bank_out, 0)::float8 AS bank_out,
    COALESCE(pm.period_transaction_count, 0)::int AS period_transaction_count
  FROM sites s
  LEFT JOIN movement m ON m.site_id = s.id
  LEFT JOIN period_movement pm ON pm.site_id = s.id
  LEFT JOIN month_movement mm ON mm.site_id = s.id
  LEFT JOIN imprest i ON i.site_id = s.id
  ORDER BY total_balance DESC, s.name ASC
`;

const TREND_SQL = `
  WITH months AS (
    SELECT generate_series(
      date_trunc('month', CURRENT_DATE) - interval '11 months',
      date_trunc('month', CURRENT_DATE),
      interval '1 month'
    )::date AS period
  ),
  movement AS (
    SELECT
      date_trunc('month', entry_date)::date AS period,
      site_id,
      COALESCE(SUM(credit), 0)::numeric AS inflow,
      COALESCE(SUM(debit), 0)::numeric AS outflow
    FROM ledger_entries
    WHERE entry_date >= date_trunc('month', CURRENT_DATE) - interval '11 months'
      AND entry_date <= CURRENT_DATE
      AND source_key !~ '_person$'
    GROUP BY 1, 2
  )
  SELECT
    to_char(months.period, 'YYYY-MM') AS period,
    to_char(months.period, 'Mon YY') AS label,
    s.id AS site_id,
    s.name AS site_name,
    COALESCE(m.inflow, 0)::float8 AS inflow,
    COALESCE(m.outflow, 0)::float8 AS outflow
  FROM months
  CROSS JOIN sites s
  LEFT JOIN movement m ON m.period = months.period AND m.site_id = s.id
  ORDER BY months.period, s.name
`;

const PERSON_SEARCH_SQL = `
  WITH person_ledgers AS (
    SELECT
      cfm.id,
      cfm.site_id,
      cfm.month,
      cfm.year,
      CASE
        WHEN cfm.linked_user_id IS NOT NULL THEN 'user:' || cfm.linked_user_id::text
        WHEN NULLIF(regexp_replace(COALESCE(lm.phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
          THEN 'phone:' || regexp_replace(lm.phone, '[^0-9]', '', 'g')
        ELSE 'name:' || UPPER(TRIM(COALESCE(lm.full_name, lu.name, cfm.ledger_name)))
      END AS identity_key,
      COALESCE(lm.full_name, lu.name, cfm.ledger_name) AS person_name,
      COALESCE(lm.phone, lu.phone) AS phone,
      COALESCE(lm.member_type, lu.role, 'PERSON') AS person_type,
      s.name AS site_name,
      s.code AS site_code
    FROM cash_flow_months cfm
    JOIN sites s ON s.id = cfm.site_id
    LEFT JOIN members lm ON lm.id = cfm.linked_member_id
    LEFT JOIN users lu ON lu.id = cfm.linked_user_id
    WHERE LOWER(COALESCE(cfm.ledger_type, '')) = 'person'
      AND (
        COALESCE(lm.full_name, lu.name, cfm.ledger_name, '') ILIKE $1
        OR COALESCE(lm.phone, lu.phone, '') ILIKE $1
        OR COALESCE(lm.email, lu.email, '') ILIKE $1
      )
  )
  SELECT
    pl.identity_key,
    pl.person_name,
    pl.phone,
    pl.person_type,
    pl.site_id,
    pl.site_name,
    pl.site_code,
    COALESCE(cfe.source_module, 'personal_ledger') AS source_module,
    COALESCE(SUM(cfe.debit), 0)::float8 AS total_debit,
    COALESCE(SUM(cfe.credit), 0)::float8 AS total_credit,
    COUNT(cfe.id)::int AS transaction_count,
    MAX(cfe.date) AS latest_activity
  FROM person_ledgers pl
  LEFT JOIN cash_flow_entries cfe
    ON cfe.cash_flow_month_id = pl.id
   AND LOWER(COALESCE(cfe.status, 'approved')) <> 'rejected'
   AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
  GROUP BY
    pl.identity_key, pl.person_name, pl.phone, pl.person_type,
    pl.site_id, pl.site_name, pl.site_code, COALESCE(cfe.source_module, 'personal_ledger')
  ORDER BY MAX(cfe.date) DESC NULLS LAST, pl.person_name
  LIMIT 500
`;

const RECORD_SEARCH_SQL = `
  SELECT
    le.site_id,
    s.name AS site_name,
    le.source_key,
    COUNT(*)::int AS transaction_count,
    COALESCE(SUM(le.debit), 0)::float8 AS total_debit,
    COALESCE(SUM(le.credit), 0)::float8 AS total_credit,
    MAX(le.entry_date) AS latest_activity,
    MAX(COALESCE(NULLIF(le.entity_name, ''), NULLIF(le.particular, ''), 'Matched record')) AS matched_name
  FROM ledger_entries le
  JOIN sites s ON s.id = le.site_id
  WHERE le.source_key !~ '_person$'
    AND (
      COALESCE(le.entity_name, '') ILIKE $1
      OR COALESCE(le.particular, '') ILIKE $1
      OR COALESCE(le.linked_detail, '') ILIKE $1
      OR COALESCE(le.remarks, '') ILIKE $1
    )
  GROUP BY le.site_id, s.name, le.source_key
  ORDER BY MAX(le.entry_date) DESC, COUNT(*) DESC
  LIMIT 100
`;

const aggregatePersonSearch = (rows) => {
  const people = new Map();
  rows.forEach((row) => {
    const key = row.identity_key;
    if (!people.has(key)) {
      people.set(key, {
        identityKey: key,
        name: row.person_name || 'Unnamed person',
        phone: row.phone || '',
        personType: row.person_type || 'PERSON',
        totalGiven: 0,
        totalReturned: 0,
        pending: 0,
        transactionCount: 0,
        latestActivity: null,
        _sites: new Map(),
        _modules: new Map(),
      });
    }
    const person = people.get(key);
    const debit = valueOf(row.total_debit);
    const credit = valueOf(row.total_credit);
    const count = valueOf(row.transaction_count);
    person.totalGiven += debit;
    person.totalReturned += credit;
    person.transactionCount += count;
    if (row.latest_activity && (!person.latestActivity || row.latest_activity > person.latestActivity)) {
      person.latestActivity = row.latest_activity;
    }

    if (!person._sites.has(row.site_id)) {
      person._sites.set(row.site_id, {
        id: row.site_id,
        name: row.site_name,
        code: row.site_code,
        given: 0,
        returned: 0,
        pending: 0,
        transactions: 0,
      });
    }
    const site = person._sites.get(row.site_id);
    site.given += debit;
    site.returned += credit;
    site.transactions += count;
    site.pending = site.given - site.returned;

    const source = normalizeDirectorSource(row.source_module);
    if (!person._modules.has(source)) {
      person._modules.set(source, {
        key: source,
        label: sourceLabel(source),
        given: 0,
        returned: 0,
        transactions: 0,
      });
    }
    const module = person._modules.get(source);
    module.given += debit;
    module.returned += credit;
    module.transactions += count;
  });

  return [...people.values()].map((person) => {
    person.pending = person.totalGiven - person.totalReturned;
    const result = {
      ...person,
      totalGiven: round2(person.totalGiven),
      totalReturned: round2(person.totalReturned),
      pending: round2(person.pending),
      siteCount: person._sites.size,
      sites: [...person._sites.values()]
        .map((site) => ({ ...site, given: round2(site.given), returned: round2(site.returned), pending: round2(site.pending) }))
        .sort((a, b) => Math.abs(b.pending) - Math.abs(a.pending)),
      modules: [...person._modules.values()]
        .map((module) => ({ ...module, given: round2(module.given), returned: round2(module.returned) }))
        .sort((a, b) => b.transactions - a.transactions),
    };
    delete result._sites;
    delete result._modules;
    return result;
  }).sort((a, b) => b.transactionCount - a.transactionCount);
};

const summarizeRecordMatches = (rows) => rows.map((row) => {
  const key = normalizeDirectorSource(row.source_key);
  return {
    siteId: row.site_id,
    siteName: row.site_name,
    moduleKey: key,
    moduleLabel: sourceLabel(key),
    matchedName: row.matched_name,
    transactionCount: valueOf(row.transaction_count),
    totalGiven: round2(row.total_debit),
    totalReturned: round2(row.total_credit),
    latestActivity: row.latest_activity,
  };
});

export async function getSiteDirectorOverview(search = '', requestedPreset = 'overall') {
  const query = String(search || '').trim().slice(0, 100);
  const searchPattern = `%${query}%`;
  const period = directorPeriodRange(String(requestedPreset || '').toLowerCase());
  const tasks = [
    pool.query(OVERVIEW_SQL, [period.dateFrom, period.dateTo]),
    pool.query(TREND_SQL),
  ];
  if (query.length >= 2) {
    tasks.push(pool.query(PERSON_SEARCH_SQL, [searchPattern]));
    tasks.push(pool.query(RECORD_SEARCH_SQL, [searchPattern]));
  }

  const [siteResult, trendResult, peopleResult, recordResult] = await Promise.all(tasks);
  const sites = siteResult.rows.map((site) => ({
    id: site.id,
    name: site.name,
    code: site.code,
    city: site.city,
    state: site.state,
    status: site.status,
    cashBook: round2(site.cash_book),
    imprestFloat: round2(site.imprest_float),
    cashBalance: round2(site.cash_balance),
    bankBalance: round2(site.bank_balance),
    totalBalance: round2(site.total_balance),
    totalInflow: round2(site.total_inflow),
    totalOutflow: round2(site.total_outflow),
    monthInflow: round2(site.month_inflow),
    monthOutflow: round2(site.month_outflow),
    transactionCount: valueOf(site.transaction_count),
    cashIn: round2(site.cash_in),
    cashOut: round2(site.cash_out),
    bankIn: round2(site.bank_in),
    bankOut: round2(site.bank_out),
    periodTransactionCount: valueOf(site.period_transaction_count),
  }));

  const totals = sites.reduce((result, site) => ({
    cashBook: result.cashBook + site.cashBook,
    imprestFloat: result.imprestFloat + site.imprestFloat,
    cashBalance: result.cashBalance + site.cashBalance,
    bankBalance: result.bankBalance + site.bankBalance,
    totalBalance: result.totalBalance + site.totalBalance,
    totalInflow: result.totalInflow + site.totalInflow,
    totalOutflow: result.totalOutflow + site.totalOutflow,
    monthInflow: result.monthInflow + site.monthInflow,
    monthOutflow: result.monthOutflow + site.monthOutflow,
    transactionCount: result.transactionCount + site.transactionCount,
    cashIn: result.cashIn + site.cashIn,
    cashOut: result.cashOut + site.cashOut,
    bankIn: result.bankIn + site.bankIn,
    bankOut: result.bankOut + site.bankOut,
    periodTransactionCount: result.periodTransactionCount + site.periodTransactionCount,
  }), {
    cashBook: 0, imprestFloat: 0, cashBalance: 0, bankBalance: 0,
    totalBalance: 0, totalInflow: 0, totalOutflow: 0,
    monthInflow: 0, monthOutflow: 0, transactionCount: 0,
    cashIn: 0, cashOut: 0, bankIn: 0, bankOut: 0, periodTransactionCount: 0,
  });

  const trendMap = new Map();
  trendResult.rows.forEach((row) => {
    if (!trendMap.has(row.period)) {
      trendMap.set(row.period, { period: row.period, label: row.label, inflow: 0, outflow: 0, net: 0 });
    }
    const month = trendMap.get(row.period);
    month.inflow += valueOf(row.inflow);
    month.outflow += valueOf(row.outflow);
    month.net = month.inflow - month.outflow;
  });

  return {
    generatedAt: new Date().toISOString(),
    period,
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round2(value)])),
    sites,
    trend: [...trendMap.values()].map((row) => ({
      ...row,
      inflow: round2(row.inflow),
      outflow: round2(row.outflow),
      net: round2(row.net),
    })),
    search: {
      query,
      people: peopleResult ? aggregatePersonSearch(peopleResult.rows) : [],
      records: recordResult ? summarizeRecordMatches(recordResult.rows) : [],
    },
  };
}

const identityFilter = (identityKey) => {
  const raw = String(identityKey || '');
  const separator = raw.indexOf(':');
  const type = separator >= 0 ? raw.slice(0, separator) : '';
  const value = separator >= 0 ? raw.slice(separator + 1) : '';

  if (type === 'user' && /^\d+$/.test(value)) {
    return { clause: 'cfm.linked_user_id = $1', value: Number(value) };
  }
  if (type === 'member' && /^\d+$/.test(value)) {
    return { clause: 'cfm.linked_member_id = $1', value: Number(value) };
  }
  if (type === 'phone' && /^\d{5,20}$/.test(value)) {
    return {
      clause: `regexp_replace(COALESCE(lm.phone, ''), '[^0-9]', '', 'g') = $1`,
      value,
    };
  }
  if (type === 'name' && value.trim()) {
    return {
      clause: `UPPER(TRIM(COALESCE(lm.full_name, lu.name, cfm.ledger_name))) = $1`,
      value: value.trim().toUpperCase(),
    };
  }
  return null;
};

export async function getSiteDirectorPerson(identityKey) {
  const filter = identityFilter(identityKey);
  if (!filter) return null;

  const targetCte = `
    WITH target_ledgers AS (
      SELECT
        cfm.id,
        cfm.site_id,
        cfm.month,
        cfm.year,
        cfm.ledger_name,
        COALESCE(lm.full_name, lu.name, cfm.ledger_name) AS person_name,
        COALESCE(lm.phone, lu.phone) AS phone,
        COALESCE(lm.email, lu.email) AS email,
        COALESCE(lm.member_type, lu.role, 'PERSON') AS person_type,
        s.name AS site_name,
        s.code AS site_code
      FROM cash_flow_months cfm
      JOIN sites s ON s.id = cfm.site_id
      LEFT JOIN members lm ON lm.id = cfm.linked_member_id
      LEFT JOIN users lu ON lu.id = cfm.linked_user_id
      WHERE LOWER(COALESCE(cfm.ledger_type, '')) = 'person'
        AND ${filter.clause}
    )
  `;

  const ledgerQuery = `${targetCte}
    SELECT DISTINCT
      site_id, site_name, site_code, person_name, phone, email, person_type
    FROM target_ledgers
    ORDER BY site_name
  `;

  const analyticsQuery = `${targetCte}
    SELECT
      tl.site_id,
      tl.site_name,
      tl.site_code,
      to_char(date_trunc('month', cfe.date), 'YYYY-MM') AS period,
      to_char(date_trunc('month', cfe.date), 'Mon YY') AS period_label,
      COALESCE(cfe.source_module, 'personal_ledger') AS source_module,
      LOWER(COALESCE(NULLIF(cfe.cash_type, ''), 'bank')) AS payment_mode,
      COALESCE(SUM(cfe.debit), 0)::float8 AS total_debit,
      COALESCE(SUM(cfe.credit), 0)::float8 AS total_credit,
      COUNT(*)::int AS transaction_count
    FROM target_ledgers tl
    JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = tl.id
    WHERE LOWER(COALESCE(cfe.status, 'approved')) <> 'rejected'
      AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    GROUP BY
      tl.site_id, tl.site_name, tl.site_code,
      date_trunc('month', cfe.date),
      COALESCE(cfe.source_module, 'personal_ledger'),
      LOWER(COALESCE(NULLIF(cfe.cash_type, ''), 'bank'))
    ORDER BY date_trunc('month', cfe.date), tl.site_name
  `;

  const transactionsQuery = `${targetCte}
    SELECT
      cfe.id,
      to_char(cfe.date, 'YYYY-MM-DD') AS date,
      cfe.particular,
      cfe.remarks,
      cfe.debit::float8 AS debit,
      cfe.credit::float8 AS credit,
      LOWER(COALESCE(NULLIF(cfe.cash_type, ''), 'bank')) AS payment_mode,
      COALESCE(cfe.source_module, 'personal_ledger') AS source_module,
      cfe.source_id,
      cfe.status,
      cfe.cheque_status,
      cfe.cheque_no,
      cfe.voucher_url,
      tl.site_id,
      tl.site_name,
      tl.site_code,
      cfe.created_at
    FROM target_ledgers tl
    JOIN cash_flow_entries cfe ON cfe.cash_flow_month_id = tl.id
    WHERE LOWER(COALESCE(cfe.status, 'approved')) <> 'rejected'
      AND UPPER(COALESCE(cfe.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')
    ORDER BY cfe.date DESC, cfe.created_at DESC, cfe.id DESC
  `;

  const [ledgerResult, analyticsResult, transactionsResult] = await Promise.all([
    pool.query(ledgerQuery, [filter.value]),
    pool.query(analyticsQuery, [filter.value]),
    pool.query(transactionsQuery, [filter.value]),
  ]);
  if (!ledgerResult.rows.length) return null;

  const personRow = ledgerResult.rows[0];
  const siteMap = new Map();
  ledgerResult.rows.forEach((row) => {
    siteMap.set(row.site_id, {
      id: row.site_id,
      name: row.site_name,
      code: row.site_code,
      given: 0,
      returned: 0,
      pending: 0,
      cashPending: 0,
      bankPending: 0,
      transactions: 0,
    });
  });

  const moduleMap = new Map();
  const trendMap = new Map();
  let totalGiven = 0;
  let totalReturned = 0;
  let cashGiven = 0;
  let cashReturned = 0;
  let bankGiven = 0;
  let bankReturned = 0;
  let transactionCount = 0;

  analyticsResult.rows.forEach((row) => {
    const debit = valueOf(row.total_debit);
    const credit = valueOf(row.total_credit);
    const count = valueOf(row.transaction_count);
    const isCash = String(row.payment_mode).toLowerCase() === 'cash';
    totalGiven += debit;
    totalReturned += credit;
    transactionCount += count;
    if (isCash) {
      cashGiven += debit;
      cashReturned += credit;
    } else {
      bankGiven += debit;
      bankReturned += credit;
    }

    const site = siteMap.get(row.site_id);
    site.given += debit;
    site.returned += credit;
    site.transactions += count;
    if (isCash) site.cashPending += debit - credit;
    else site.bankPending += debit - credit;
    site.pending = site.given - site.returned;

    const source = normalizeDirectorSource(row.source_module);
    if (!moduleMap.has(source)) {
      moduleMap.set(source, { key: source, label: sourceLabel(source), given: 0, returned: 0, pending: 0, transactions: 0 });
    }
    const module = moduleMap.get(source);
    module.given += debit;
    module.returned += credit;
    module.pending = module.given - module.returned;
    module.transactions += count;

    if (!trendMap.has(row.period)) {
      trendMap.set(row.period, {
        period: row.period,
        label: row.period_label,
        given: 0,
        returned: 0,
        pendingMovement: 0,
      });
    }
    const month = trendMap.get(row.period);
    month.given += debit;
    month.returned += credit;
    month.pendingMovement = month.given - month.returned;
  });

  const rounded = (row, keys) => {
    const result = { ...row };
    keys.forEach((key) => { result[key] = round2(result[key]); });
    return result;
  };

  return {
    generatedAt: new Date().toISOString(),
    identityKey,
    person: {
      name: personRow.person_name,
      phone: personRow.phone || '',
      email: personRow.email || '',
      type: personRow.person_type || 'PERSON',
    },
    summary: {
      totalGiven: round2(totalGiven),
      totalReturned: round2(totalReturned),
      pending: round2(totalGiven - totalReturned),
      cashPending: round2(cashGiven - cashReturned),
      bankPending: round2(bankGiven - bankReturned),
      cashGiven: round2(cashGiven),
      cashReturned: round2(cashReturned),
      bankGiven: round2(bankGiven),
      bankReturned: round2(bankReturned),
      transactionCount,
      siteCount: siteMap.size,
    },
    sites: [...siteMap.values()]
      .map((site) => rounded(site, ['given', 'returned', 'pending', 'cashPending', 'bankPending']))
      .sort((a, b) => Math.abs(b.pending) - Math.abs(a.pending)),
    modules: [...moduleMap.values()]
      .map((module) => rounded(module, ['given', 'returned', 'pending']))
      .sort((a, b) => b.transactions - a.transactions),
    trend: [...trendMap.values()]
      .map((month) => rounded(month, ['given', 'returned', 'pendingMovement']))
      .sort((a, b) => a.period.localeCompare(b.period)),
    transactions: transactionsResult.rows.map((row) => {
      const source = normalizeDirectorSource(row.source_module);
      return {
        id: row.id,
        date: row.date,
        particular: row.particular,
        remarks: row.remarks,
        debit: round2(row.debit),
        credit: round2(row.credit),
        paymentMode: row.payment_mode,
        moduleKey: source,
        moduleLabel: sourceLabel(source),
        sourceId: row.source_id,
        status: row.status,
        chequeStatus: row.cheque_status,
        chequeNo: row.cheque_no,
        voucherUrl: row.voucher_url,
        siteId: row.site_id,
        siteName: row.site_name,
        siteCode: row.site_code,
      };
    }),
  };
}
