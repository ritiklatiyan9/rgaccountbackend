import { assertHistoryCursorScope, decodeHistoryCursor, encodeHistoryCursor, historyFingerprint } from './requestHistoryCursor.js';
import { historyClock, historyCoalesce, historyDeciderFields, historyDecisionFields, historyTimestamp } from './requestHistoryClock.js';
import { runHistoryQuery } from './requestHistoryQuery.js';
import { historyProjectionFields, historySourceSql } from './requestHistoryProjection.js';

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
const schemaCache = new WeakMap();
async function sourceSchema(db) {
  let entry = schemaCache.get(db);
  if (!entry || entry.expires <= Date.now()) {
    entry = { expires: Date.now() + 60000, promise: db.query(`SELECT table_name,column_name,data_type,udt_name,is_nullable,current_setting('TimeZone') AS history_timezone
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
  const source = query.source || null;
  if (source && !Object.hasOwn(HISTORY_TABLES, source) && !['daybook_farmer','daybook_commission','daybook_expense','daybook_general'].includes(source)) fail('Invalid history request type.');
  const recordId = query.record_id == null ? null : String(query.record_id);
  if (recordId && (!source || !/^(?:[1-9][0-9]{0,19}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(recordId))) fail('Invalid history record reference.');
  if (query.pagination != null && !['cursor','offset'].includes(query.pagination)) fail('Invalid history pagination.');
  if (query.view != null && !['summary','full'].includes(query.view)) fail('Invalid history view.');
  if (query.include_total != null && !['true','false',true,false].includes(query.include_total)) fail('Invalid history count setting.');
  const cursorMode = query.pagination === 'cursor';
  if (query.after && !cursorMode) fail('A history cursor requires cursor pagination.');
  return { siteId, status, search, source, recordId, summary: query.view === 'summary', cursorMode,
    includeTotal: query.include_total !== 'false' && query.include_total !== false,
    cursor: query.after ? decodeHistoryCursor(query.after) : null,
    from: dates[0], to: dates[1], page: positive(query.page, 1, 100000), pageSize: positive(query.page_size, 20, 50) };
}

const SUMMARY_FIELDS = `id site_id status source _type module module_label entity_name entity_type entity_plot_no title
  amount debit credit created_at date requested_by_name created_by_name assigned_admin_name asked_to_name
  party_name category sub_category category_name entry_type particular description reason remarks remark subject_label entity_secondary
  plot_no buyer_name plot_status scheme direction request_type sub_admin_name ledger_name ledger_type linked_user_name
  to_name name firm_name transfer_to_firm_name from_entity to_entity source_label target_label record_id record_buyer_name record_booked_by agent_name vendor_name
  farmer_name activity_label`.split(/\s+/);
const SEARCH_FIELDS = [...SUMMARY_FIELDS, 'notes', 'reference', 'reference_no', 'transaction_no', 'cheque_no', 'entity_phone'];
const terminal = "lower(h.status::text) IN ('approved','accepted','received','returned','rejected','declined')";
const order = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `${p}history_at DESC NULLS LAST,${p}source COLLATE "C",CASE WHEN ${p}id ~ '^[0-9]+$' THEN ${p}id::numeric END DESC NULLS LAST,${p}id COLLATE "C" DESC`;
};
const jsonObject = fields => {
  const chunks = [];
  for (let index = 0; index < fields.length; index += 40) chunks.push(`jsonb_build_object(${fields.slice(index, index + 40).join(',')})`);
  return chunks.join(' || ') || "'{}'::jsonb";
};

/** Sources retain their existing tenant/assignment predicates. Only keys enter
 * the merge; cursor reads bound every branch before the global merge. */
export function createRequestHistoryReader(db, options) {
  const sources = [];
  let metadata;
  const prepare = async () => (metadata ||= await sourceSchema(db));
  return {
    prepare,
    hasColumn(table, column) { return metadata?.get(table)?.has(column) === true; },
    add(sql, params = [], map = row => row, key = sql.match(/'([a-z_]+)'(?:::\w+)?\s+AS\s+source/i)?.[1]) {
      const wanted = options.source?.startsWith('daybook_') ? 'daybook' : options.source;
      if (!wanted || !key || key === wanted) sources.push({ sql, params, map, key });
    },
    async read() {
      if (!sources.length) return { rows: [], total: options.includeTotal === false ? null : 0, hasMore: false };
      const schema = await prepare();
      const fingerprint = historyFingerprint([options.authorizationScope, options.siteId, options.status, options.search,
        options.source, options.recordId, options.from, options.to, options.pageSize, options.summary,
        sources.map(source => [source.key, source.sql, source.params])]);
      assertHistoryCursorScope(options.cursor, fingerprint);
      const snapshot = options.cursorMode ? options.cursor?.snapshot || new Date().toISOString() : null;
      const values = [], ctes = [], candidates = [], counts = [], hydration = [];
      const bind = value => `$${values.push(value)}`;
      const states = options.status === 'accepted' ? accepted : options.status === 'rejected' ? rejected : [...accepted, ...rejected];
      const stateParam = bind(states), searchParam = options.search && bind(options.search);
      const fromParam = options.from && bind(options.from), toParam = options.to && bind(options.to);
      const snapshotParam = snapshot && bind(snapshot);
      const cursor = options.cursor?.key;
      const timeParam = cursor && bind(cursor.time), sourceParam = cursor && bind(cursor.source), idParam = cursor && bind(cursor.id);
      const take = options.cursorMode ? options.pageSize + 1 : options.page * options.pageSize + 1;
      sources.forEach((source, index) => {
        const columns = schema.get(HISTORY_TABLES[source.key]);
        const idType = columns?.get('id')?.udt_name;
        const { decision, event } = historyClock(columns);
        const deciderValues = historyDeciderFields.map(field => columns ? columns.has(field) ? `h.${field}::text` : null : `to_jsonb(h)->>'${field}'`).filter(Boolean);
        const decider = deciderValues.length ? `(${historyCoalesce(deciderValues)})::int` : 'NULL::int';
        const where = [terminal, `lower(h.status::text)=ANY(${stateParam}::text[])`];
        const known = columns && historyProjectionFields(source.sql,columns);
        if (searchParam) {
          if (options.summary && known) {
            const fields = SEARCH_FIELDS.filter(field => known.has(field)).map(field => `COALESCE(h.${field}::text,'')`);
            if(source.key === 'edit_request' && columns?.has('original_data')) {
              for(const field of ['party_name','buyer_name','customer_name','full_name','name','to_entity','from_entity','plot_no']) fields.push(`COALESCE(h.original_data->>'${field}','')`);
            }
            where.push(`strpos(lower(concat_ws(' ',${fields.join(',')})),lower(${searchParam}))>0`);
          } else where.push(`strpos(lower(to_jsonb(h)::text),lower(${searchParam}))>0`);
        }
        if (fromParam) where.push(`${event} >= (${fromParam}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`);
        if (toParam) where.push(`${event} < ((${toParam}::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata')`);
        if (snapshotParam) {
          where.push(`(${event}<=${snapshotParam}::timestamptz OR ${event} IS NULL)`);
          const created = historyTimestamp(columns,'h','created_at');
          if (created) where.push(`(${created}<=${snapshotParam}::timestamptz OR ${created} IS NULL)`);
        }
        if (options.recordId) {
          const id = options.recordId;
          const numeric = /^[0-9]+$/.test(id);
          const valid = idType === 'uuid' ? !numeric : ['int2','int4','int8'].includes(idType)
            ? numeric && BigInt(id) <= ({int2:32767n,int4:2147483647n,int8:9223372036854775807n})[idType] : true;
          where.push(valid ? ['uuid','int2','int4','int8'].includes(idType)
            ? `h.id=${bind(id)}::${idType}` : `h.id::text=${bind(id)}::text` : 'FALSE');
        }
        const offset = values.length;
        values.push(...source.params);
        const required = options.summary ? new Set([...SUMMARY_FIELDS,...SEARCH_FIELDS,...historyDecisionFields,...historyDeciderFields,
          'updated_at','created_at','date','payment_date','transfer_date',...(source.key==='edit_request'?['original_data']:[]),
          ...(source.key==='plot_status'?['approval_original_data','approval_proposed_data']:[])]) : null;
        const sql = historySourceSql(source.sql.trim().replace(/\s+ORDER BY\s+[^\n]+$/i,''),columns,required)
          .replace(/\$(\d+)\b/g, (_, number) => `$${Number(number) + offset}`);
        ctes.push(`source_${index} AS NOT MATERIALIZED (${sql})`);
        const sortSource = source.key === 'daybook' ? `CASE h.entry_type WHEN 'FARMER PAYMENT' THEN 'daybook_farmer'
          WHEN 'PLOT COMMISSION' THEN 'daybook_commission' WHEN 'EXPENSE' THEN 'daybook_expense' WHEN 'GENERAL' THEN 'daybook_general' ELSE 'daybook' END` : 'h.source';
        if (options.source && options.source !== 'daybook') where.push(`${sortSource}=${bind(options.source)}::text`);
        if (options.includeTotal !== false) counts.push(`SELECT count(*)::bigint AS n FROM source_${index} h WHERE ${where.join(' AND ')}`);
        if (cursor) {
          const family = cursor.source.startsWith('daybook_') ? 'daybook' : cursor.source;
          const idLess = source.key && source.key !== family ? 'FALSE' : ['uuid','int2','int4','int8'].includes(idType)
            ? `h.id<${idParam}::${idType}` : /^[0-9]+$/.test(cursor.id)
              ? `CASE WHEN h.id::text ~ '^[0-9]+$' THEN h.id::numeric<${idParam}::numeric ELSE FALSE END`
              : `h.id::text COLLATE "C"<${idParam}::text COLLATE "C"`;
          where.push(`((${timeParam}::timestamptz IS NOT NULL AND (${event}<${timeParam}::timestamptz OR ${event} IS NULL))
            OR (${event} IS NOT DISTINCT FROM ${timeParam}::timestamptz AND (${sortSource} COLLATE "C">${sourceParam}::text COLLATE "C"
              OR (${sortSource}=${sourceParam} AND ${idLess}))))`);
        }
        const candidate = conditions => candidates.push(`(SELECT ${index} AS source_index,h.id::text AS id,${sortSource} AS source,
          ${event} AS history_at,${decision} AS history_decided_at,${decider} AS decider_id
          FROM source_${index} h WHERE ${conditions.join(' AND ')}
          ORDER BY ${event} DESC NULLS LAST,${sortSource} COLLATE "C",h.id DESC LIMIT ${bind(take)})`);
        if(options.cursorMode) {
          // Separate NULL clocks so the dated branch has a direct B-tree range
          // condition and does not scan all newer records before a deep cursor.
          if(!cursor || cursor.time !== null) candidate([...where,`${event} IS NOT NULL`,`${event}<=${snapshotParam}::timestamptz`,
            ...(cursor ? [`${event}<=${timeParam}::timestamptz`] : [])]);
          const nonnull = columns && [...historyDecisionFields,'updated_at','created_at','date','payment_date','transfer_date']
            .some(field=>columns.get(field)?.is_nullable==='NO');
          if(!nonnull && !options.from && !options.to) candidate([...where,`${event} IS NULL`]);
        } else candidate(where);
        const idMatch = ['uuid','int2','int4','int8'].includes(idType) ? `h.id=CASE WHEN p.source_index=${index} THEN p.id::${idType} END` : 'h.id::text=p.id';
        const numericFields = new Set(['amount','debit','credit',...[...(columns?.values() || [])].filter(column => ['numeric','int8'].includes(column.udt_name)).map(column => column.column_name)]);
        let payload;
        if (options.summary && known) {
          payload = jsonObject(SUMMARY_FIELDS.filter(field => known.has(field)).map(field => `'${field}',h.${field}${numericFields.has(field) ? '::text' : ''}`));
          if (source.key === 'edit_request' && columns?.has('original_data')) {
            const names=['party_name','buyer_name','customer_name','full_name','name','to_entity','from_entity','plot_no'];
            payload += ` || jsonb_build_object('original_data',jsonb_strip_nulls(${jsonObject(names.map(field => `'${field}',h.original_data->'${field}'`))}))`;
          }
          if (source.key === 'plot_status') {
            const snapshots=['approval_original_data','approval_proposed_data'].filter(field=>known.has(field));
            if(snapshots.length)payload += ` || ${jsonObject(snapshots.map(field=>`'${field}',h.${field}`))}`;
          }
        } else {
          const numericParam = bind([...numericFields]);
          payload = `(SELECT jsonb_object_agg(field.key,CASE WHEN field.key=ANY(${numericParam}::text[]) AND jsonb_typeof(field.value)='number'
            THEN to_jsonb(field.value #>> '{}') ELSE field.value END) FROM jsonb_each(to_jsonb(h)) field)`;
        }
        hydration.push(`SELECT p.*,${payload} AS payload FROM page p JOIN source_${index} h ON p.source_index=${index} AND ${idMatch}`);
      });
      ctes.push(`matched AS MATERIALIZED (${candidates.join('\nUNION ALL\n')})`,
        `selected AS MATERIALIZED (SELECT * FROM matched ORDER BY ${order()} LIMIT ${bind(options.pageSize + 1)}${options.cursorMode ? '' : ` OFFSET ${bind((options.page-1)*options.pageSize)}`})`,
        `page AS MATERIALIZED (SELECT * FROM selected ORDER BY ${order()} LIMIT ${bind(options.pageSize)})`,
        `hydrated AS (${hydration.join('\nUNION ALL\n')})`);
      const sql = `WITH ${ctes.join(',\n')}
        SELECT ${counts.length ? `(SELECT sum(n) FROM (${counts.join(' UNION ALL ')}) counts)` : 'NULL::bigint'} AS total,
          (SELECT count(*)>${bind(options.pageSize)} FROM selected) AS has_more,
          ${snapshotParam ? `${snapshotParam}::text` : 'NULL::text'} AS snapshot,
          (SELECT jsonb_build_object('time',history_at,'source',source,'id',id) FROM page ORDER BY ${order()} OFFSET ${bind(options.pageSize - 1)} LIMIT 1) AS next_key,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('source_index',r.source_index,'entry',r.payload || jsonb_build_object(
            'history_at',r.history_at,'history_decided_at',r.history_decided_at,'history_decided_by_name',COALESCE(decider.name,decider.email))) ORDER BY ${order('r')})
            FROM hydrated r LEFT JOIN users decider ON decider.id=r.decider_id),'[]'::jsonb) AS entries`;
      const sharedKey = historyFingerprint([fingerprint, options.page, options.cursor || null, options.recordId, options.includeTotal]);
      const { rows: [result] } = await runHistoryQuery(db,sql,values,sharedKey);
      const rows = (result?.entries || []).map(({source_index,entry}) => ({...sources[source_index].map(entry),can_decide:false,...(options.summary ? {history_summary:true} : {})}));
      const actualSnapshot = result?.snapshot || snapshot;
      const nextCursor = options.cursorMode && result?.has_more && result.next_key ? encodeHistoryCursor({v:1,fingerprint,
        snapshot:actualSnapshot,expires:options.cursor?.expires || Date.now()+15*60*1000,key:result.next_key}) : null;
      return { rows, total: result?.total == null ? null : Number(result.total), hasMore: result?.has_more === true,
        nextCursor, snapshot: actualSnapshot };
    },
  };
}
