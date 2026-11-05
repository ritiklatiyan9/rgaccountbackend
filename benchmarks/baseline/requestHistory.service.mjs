const accepted = ['approved', 'accepted', 'received', 'returned'];
const rejected = ['rejected', 'declined'];
export const HISTORY_TABLES = Object.freeze({
  transaction_transfer: 'transaction_transfer_approval_requests', plot_status: 'plot_status_approvals',
  farmer_payment: 'farmer_payments', land_deal_payment: 'land_deal_payments', misc_income_entry: 'misc_income_entries',
  plot_commission: 'plot_commissions', plot_commission_payment: 'plot_commission_payments',
  cash_flow_entry: 'cash_flow_entries', firm_transaction: 'firm_transactions', plot_payment: 'plot_payments',
  plot_installment_payment: 'plot_installment_payments', expense: 'expenses', vendor_payment: 'vendor_payments',
  plot_registry_payment: 'plot_registry_payments', vendor_inventory_payment: 'vendor_inventory_payments', daybook: 'day_book',
  edit_request: 'edit_requests', seek_permission: 'seek_permissions', wallet_transfer: 'loyalty_vault_transfers',
  wallet_imprest_transfer: 'wallet_imprest_transfers', imprest: 'imprest_expense_requests',
  imprest_return: 'imprest_returns', imprest_allocation: 'imprest_allocations',
});
const decisionFields = ['resolved_at', 'decided_at', 'reviewed_at', 'confirmed_at', 'received_at', 'approved_at', 'rejected_at', 'declined_at', 'accepted_at'];
const deciderFields = ['resolved_by', 'decided_by', 'reviewed_by', 'approved_by', 'confirmed_by', 'accepted_by', 'rejected_by'];
const schemaCache = new WeakMap();
async function sourceSchema(db) {
  let entry = schemaCache.get(db);
  if (!entry || entry.expires <= Date.now()) {
    entry = { expires: Date.now() + 60000, promise: db.query(`SELECT table_name,column_name,data_type,udt_name
      FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.values(HISTORY_TABLES)])
      .then(({ rows }) => {
        const tables = new Map();
        for (const row of rows) {
          if (!tables.has(row.table_name)) tables.set(row.table_name, new Map());
          tables.get(row.table_name).set(row.column_name, row);
        }
        return tables;
      }).catch(error => { schemaCache.delete(db); throw error; }) };
    schemaCache.set(db, entry);
  }
  return entry.promise;
}
const fail = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const positive = (value, fallback, max) => {
  if (value == null) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) fail('Invalid history pagination.');
  return Number(value);
};
export function requestHistoryOptions(query) {
  const siteId = positive(query.site_id, null, 2147483647);
  if (!siteId) fail('Select a valid site.');
  const status = query.status || 'all';
  if (!['all', 'accepted', 'rejected'].includes(status)) fail('Choose All, Accepted or Rejected.');
  const dates = [query.from, query.to].map(value => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('Invalid history date.');
    return value;
  });
  if (dates[0] && dates[1] && dates[0] > dates[1]) fail('Start date must be before end date.');
  const search = String(query.q || '').trim();
  if (search.length > 200) fail('Search must be 200 characters or fewer.');
  return { siteId, status, search, from: dates[0], to: dates[1], page: positive(query.page, 1, 100000), pageSize: positive(query.page_size, 20, 50) };
}

// Register the existing, access-scoped source queries without executing them.
// One statement counts/ranks narrow keys across all modules and only hydrates
// the requested page. Joins, document signing and JSON serialization therefore
// never run for page × page_size rows from every module.
export function createRequestHistoryReader(db, options) {
  const sources = [];
  let metadata;
  const prepare = async () => (metadata ||= await sourceSchema(db));
  return { prepare, hasColumn(table, column) { return metadata?.get(table)?.has(column) === true; },
    add(sql, params = [], map = row => row, key = sql.match(/'([a-z_]+)'(?:::\w+)?\s+AS\s+source/i)?.[1]) { sources.push({ sql, params, map, key }); }, async read() {
    if (!sources.length) return { rows: [], total: 0 };
    const schema = await prepare();
    const values = [], ctes = [], candidates = [], hydration = [];
    const bind = value => `$${values.push(value)}`;
    const states = options.status === 'accepted' ? accepted : options.status === 'rejected' ? rejected : [...accepted, ...rejected];
    const stateParam = bind(states), searchParam = options.search && bind(options.search);
    const fromParam = options.from && bind(options.from), toParam = options.to && bind(options.to);
    sources.forEach((source, index) => {
      const columns = schema.get(HISTORY_TABLES[source.key]);
      const json = 'to_jsonb(h)';
      const timestamp = field => columns ? columns.has(field) ? `h.${field}::timestamptz` : null : `NULLIF(${json}->>'${field}','')::timestamptz`;
      const coalesce = parts => parts.length > 1 ? `COALESCE(${parts.join(',')})` : parts[0] || 'NULL::timestamptz';
      const decision = coalesce(decisionFields.map(timestamp).filter(Boolean));
      const event = coalesce([decision, ...['updated_at', 'created_at', 'date', ...(columns ? ['payment_date', 'transfer_date'] : [])].map(timestamp).filter(Boolean)]);
      const deciderValues = deciderFields.map(field => columns ? columns.has(field) ? `h.${field}::text` : null : `${json}->>'${field}'`).filter(Boolean);
      const decider = deciderValues.length ? `(${coalesce(deciderValues)})::int` : 'NULL::int';
      const where = ["lower(h.status::text) IN ('approved','accepted','received','returned','rejected','declined')", `lower(h.status::text)=ANY(${stateParam}::text[])`];
      if (searchParam) where.push(`strpos(lower(to_jsonb(h)::text),lower(${searchParam}))>0`);
      if (fromParam) where.push(`${event} >= (${fromParam}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
      if (toParam) where.push(`${event} < ((${toParam}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
      const offset = values.length;
      values.push(...source.params);
      const sql = source.sql.trim().replace(/\s+ORDER BY\s+[^\n]+$/i, '').replace(/\$(\d+)\b/g, (_, number) => `$${Number(number) + offset}`);
      ctes.push(`source_${index} AS NOT MATERIALIZED (${sql})`);
      const sortSource = source.key === 'daybook' ? `CASE h.entry_type WHEN 'FARMER PAYMENT' THEN 'daybook_farmer'
        WHEN 'PLOT COMMISSION' THEN 'daybook_commission' WHEN 'EXPENSE' THEN 'daybook_expense' WHEN 'GENERAL' THEN 'daybook_general' ELSE 'daybook' END` : 'h.source';
      candidates.push(`SELECT ${index} AS source_index,h.id::text AS id,${sortSource} AS source,
        ${event} AS history_at,${decision} AS history_decided_at,${decider} AS decider_id
        FROM source_${index} h WHERE ${where.join(' AND ')}`);
      const idType = columns?.get('id')?.udt_name;
      const idMatch = ['uuid', 'int2', 'int4', 'int8'].includes(idType) ? `h.id=CASE WHEN p.source_index=${index} THEN p.id::${idType} END` : 'h.id::text=p.id';
      // PostgreSQL's JSON decoder otherwise turns exact numeric strings into JS
      // numbers. Preserve the existing API's decimal representation on the page.
      const numericFields = [...new Set(['amount', 'debit', 'credit', ...[...(columns?.values() || [])].filter(column => ['numeric', 'int8'].includes(column.udt_name)).map(column => column.column_name)])];
      const numericParam = bind(numericFields);
      const payload = `(SELECT jsonb_object_agg(field.key,CASE WHEN field.key=ANY(${numericParam}::text[]) AND jsonb_typeof(field.value)='number'
        THEN to_jsonb(field.value #>> '{}') ELSE field.value END) FROM jsonb_each(to_jsonb(h)) field)`;
      hydration.push(`SELECT p.*,${payload} AS payload FROM page p JOIN source_${index} h ON p.source_index=${index} AND ${idMatch}`);
    });
    const order = `history_at DESC NULLS LAST,source COLLATE "C",CASE WHEN id ~ '^[0-9]+$' THEN id::numeric END DESC NULLS LAST,id COLLATE "C" DESC`;
    ctes.push(`matched AS MATERIALIZED (${candidates.join('\nUNION ALL\n')})`,
      `page AS MATERIALIZED (SELECT * FROM matched ORDER BY ${order} LIMIT ${bind(options.pageSize)} OFFSET ${bind((options.page - 1) * options.pageSize)})`,
      `hydrated AS (${hydration.join('\nUNION ALL\n')})`);
    const { rows: [result] } = await db.query(`WITH ${ctes.join(',\n')}
      SELECT (SELECT count(*)::int FROM matched) AS total,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('source_index',r.source_index,'entry',r.payload || jsonb_build_object(
          'history_at',r.history_at,'history_decided_at',r.history_decided_at,
          'history_decided_by_name',COALESCE(decider.name,decider.email))) ORDER BY ${order.split(',').map(part => part.replace(/\b(history_at|source|id)\b/g, 'r.$1')).join(',')})
          FROM hydrated r LEFT JOIN users decider ON decider.id=r.decider_id), '[]'::jsonb) AS entries`, values);
    return { total: Number(result?.total) || 0, rows: (result?.entries || []).map(({ source_index, entry }) => ({ ...sources[source_index].map(entry), can_decide: false })) };
  } };
}
