export function summarizeCalendarSync(accounts = []) {
  if (!accounts.length) return 'DISCONNECTED';
  if (accounts.some(account => account.connection_status === 'reauthorization_required' || account.sync_status === 'FAILED')) return 'FAILED';
  if (accounts.some(account => account.sync_status === 'PROCESSING')) return 'PROCESSING';
  return accounts.every(account => account.sync_status === 'SYNCED') ? 'SYNCED' : 'PENDING';
}

// Call with source aliases and event types defined by the calendar queries.
export function calendarSyncStatusSql(alias, eventType) {
  return `(SELECT CASE
    WHEN COUNT(c.id)=0 THEN 'DISCONNECTED'
    WHEN BOOL_OR(c.status='reauthorization_required' OR g.sync_status='FAILED') THEN 'FAILED'
    WHEN BOOL_OR(g.sync_status='PROCESSING') THEN 'PROCESSING'
    WHEN COUNT(g.id)<COUNT(c.id) OR BOOL_OR(g.sync_status IS DISTINCT FROM 'SYNCED') THEN 'PENDING'
    ELSE 'SYNCED' END
    FROM google_calendar_connections c LEFT JOIN google_calendar_event_links g
      ON g.connection_id=c.id AND g.organization_id=c.organization_id
      AND g.event_type='${eventType}' AND g.source_id=${alias}.id
    WHERE c.organization_id=${alias}.organization_id AND c.status IN ('active','reauthorization_required'))`;
}
