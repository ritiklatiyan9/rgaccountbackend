const RESTORE_REASON = 'Cancelled during backup restore; review before creating a new delivery.';

export const OPERATIONAL_TABLES = new Set([
  'event_reminders', 'compliance_notification_log', 'client_message_deliveries',
  'client_message_campaigns', 'sms_reminder_log', 'google_calendar_connections', 'login_otps',
]);

/**
 * Called inside the restore transaction with application triggers disabled.
 * A full replacement must not reactivate messages or login challenges captured
 * before they were delivered/consumed. Financial approvals remain untouched.
 * Merge only changes identities returned by the caller's successful INSERTs;
 * existing live operational state is never matched merely by archive content.
 */
export async function neutralizeRestoredJobs(client, schema, tables, { mode, insertedIds = new Map() } = {}) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('Operational restore mode must be merge or replace.');
  const summary = { cancelledJobs: 0, calendarReconnectRequired: false, invalidatedLoginChallenges: 0 };
  const included = new Set(tables.map((table) => table.name));
  const columnsByTable = new Map(schema.tables.filter((table) => included.has(table.name))
    .map((table) => [table.name, new Set(table.columns.map((column) => column.name))]));
  const has = (table, ...columns) => columns.every((column) => columnsByTable.get(table)?.has(column));
  const optionalSet = (table, column, expression) => has(table, column) ? `, ${column}=${expression}` : '';
  const mergeIds = (table) => {
    const ids = insertedIds instanceof Map ? insertedIds.get(table) : insertedIds?.[table];
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.length)) throw new Error('Inserted operational identities must be arrays of ID strings.');
    return [...new Set(ids)];
  };
  const eligible = (table, ...columns) => has(table, ...columns)
    && (mode === 'replace' || (has(table, 'id') && mergeIds(table).length > 0));
  const scope = (table, parameters, alias = '') => {
    if (mode === 'replace') return '';
    parameters.push(mergeIds(table));
    return ` AND ${alias}id::text=ANY($${parameters.length}::text[])`;
  };
  const cancel = async (table, newStatus, pending, reasonColumn) => {
    if (!eligible(table, 'status')) return;
    const extra = optionalSet(table, reasonColumn, '$2') + optionalSet(table, 'updated_at', 'CURRENT_TIMESTAMP');
    const parameters = has(table, reasonColumn) ? [newStatus, RESTORE_REASON, pending] : [newStatus, pending];
    const query = `UPDATE public.${table} SET status=$1${extra} WHERE status=ANY($${parameters.length}::text[])${scope(table, parameters)}`;
    const result = await client.query(query, parameters);
    summary.cancelledJobs += result.rowCount || 0;
  };

  // Identifiers here are fixed code constants. Uploaded metadata only decides
  // whether the corresponding installed table/columns are present.
  await cancel('event_reminders', 'CANCELLED', ['PENDING', 'PROCESSING', 'FAILED'], 'failure_reason');
  await cancel('compliance_notification_log', 'SKIPPED', ['PENDING', 'PROCESSING', 'FAILED'], 'failure_reason');
  await cancel('client_message_deliveries', 'SKIPPED', ['QUEUED', 'SENDING'], 'error');
  await cancel('sms_reminder_log', 'cancelled', ['queued', 'processing', 'sending'], 'error');

  if (eligible('client_message_campaigns', 'id', 'status') && has('client_message_deliveries', 'campaign_id', 'status')) {
    const counters = [['sent_count', 'sent'], ['failed_count', 'failed'], ['skipped_count', 'skipped']]
      .map(([column, aggregate]) => optionalSet('client_message_campaigns', column, `totals.${aggregate}`)).join('');
    const parameters = [];
    await client.query(`
      WITH totals AS (
        SELECT campaign.id,
          COUNT(delivery.campaign_id) FILTER (WHERE delivery.status='SENT')::int AS sent,
          COUNT(delivery.campaign_id) FILTER (WHERE delivery.status='FAILED')::int AS failed,
          COUNT(delivery.campaign_id) FILTER (WHERE delivery.status='SKIPPED')::int AS skipped,
          COUNT(delivery.campaign_id) FILTER (WHERE delivery.status IN ('QUEUED','SENDING'))::int AS pending
        FROM public.client_message_campaigns campaign
        LEFT JOIN public.client_message_deliveries delivery ON delivery.campaign_id=campaign.id
        WHERE campaign.status IN ('QUEUING','QUEUED','SENDING')${scope('client_message_campaigns', parameters, 'campaign.')}
        GROUP BY campaign.id
      )
      UPDATE public.client_message_campaigns campaign
      SET status=CASE WHEN totals.pending>0 THEN 'SENDING'
                     WHEN totals.failed=0 THEN 'COMPLETED'
                     WHEN totals.sent=0 THEN 'FAILED' ELSE 'PARTIAL' END
          ${counters}${optionalSet('client_message_campaigns', 'updated_at', 'CURRENT_TIMESTAMP')}
      FROM totals WHERE campaign.id=totals.id`, parameters);
  }

  if (eligible('google_calendar_connections', 'status')) {
    const parameters = [];
    const result = await client.query(`UPDATE public.google_calendar_connections
      SET status='reauthorization_required'${optionalSet('google_calendar_connections', 'updated_at', 'CURRENT_TIMESTAMP')}
      WHERE status='active'${scope('google_calendar_connections', parameters)}`, parameters);
    summary.calendarReconnectRequired = result.rowCount > 0;
  }

  if (eligible('login_otps', 'consumed_at')) {
    const parameters = [];
    const result = await client.query(`UPDATE public.login_otps SET consumed_at=CURRENT_TIMESTAMP WHERE consumed_at IS NULL${scope('login_otps', parameters)}`, parameters);
    summary.invalidatedLoginChallenges = result.rowCount || 0;
  } else if (eligible('login_otps', 'expires_at')) {
    const parameters = [];
    const result = await client.query(`UPDATE public.login_otps SET expires_at=CURRENT_TIMESTAMP-INTERVAL '1 second'
      WHERE (expires_at IS NULL OR expires_at>=CURRENT_TIMESTAMP)${scope('login_otps', parameters)}`, parameters);
    summary.invalidatedLoginChallenges = result.rowCount || 0;
  }
  return summary;
}
