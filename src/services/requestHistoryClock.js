export const historyDecisionFields = ['resolved_at', 'decided_at', 'reviewed_at', 'confirmed_at', 'received_at', 'approved_at', 'rejected_at', 'declined_at', 'accepted_at'];
export const historyDeciderFields = ['resolved_by', 'decided_by', 'reviewed_by', 'approved_by', 'confirmed_by', 'accepted_by', 'rejected_by'];
export const historyCoalesce = parts => parts.length > 1 ? `COALESCE(${parts.join(',')})` : parts[0] || 'NULL::timestamptz';
const quoted = value => `'${String(value).replaceAll("'", "''")}'`;
export function historyTimestamp(columns, alias, field) {
  if (!columns) return `NULLIF(to_jsonb(${alias})->>'${field}','')::timestamptz`;
  const column = columns.get(field);
  if (!column) return null;
  const ref = `${alias ? `${alias}.` : ''}${field}`;
  // Explicit database timezone preserves the existing conversion, while making
  // the expression immutable and usable by a B-tree expression index.
  if (column.data_type === 'timestamp without time zone' || column.data_type === 'date') {
    return `(${ref}::timestamp AT TIME ZONE ${quoted(column.history_timezone || 'UTC')})`;
  }
  return `${ref}::timestamptz`;
}
export function historyClock(columns, alias = 'h') {
  const decision = historyCoalesce(historyDecisionFields.map(field => historyTimestamp(columns, alias, field)).filter(Boolean));
  const event = historyCoalesce([decision, ...['updated_at', 'created_at', 'date', ...(columns ? ['payment_date', 'transfer_date'] : [])]
    .map(field => historyTimestamp(columns, alias, field)).filter(Boolean)]);
  return { decision, event };
}
