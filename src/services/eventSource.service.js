import pool from '../config/db.js';

export const EVENT_SOURCES = Object.freeze({
  COMPLIANCE: {
    table: 'compliance_items', title: 'title', date: 'current_due_date', timed: false,
    description: 'description', ownerIds: ['assigned_to', 'reviewing_manager_id', 'approving_authority_id', 'created_by'],
    terminal: ['COMPLETED', 'NOT_APPLICABLE', 'CANCELLED'], path: (id) => `/compliance/register/${id}`,
  },
  LEGAL_HEARING: {
    table: 'legal_cases', title: 'title', date: 'next_hearing_date', timed: true,
    description: 'summary', ownerIds: ['internal_owner_id', 'created_by'],
    terminal: ['CLOSED', 'SETTLED', 'CANCELLED'], path: (id) => `/legal/cases/${id}`,
  },
  NOTICE_REPLY: {
    table: 'legal_notices', title: 'subject', date: 'reply_due_date', timed: false,
    description: 'summary', ownerIds: ['responsible_person_id', 'reviewing_manager_id', 'created_by'],
    terminal: ['CLOSED', 'REPLY_SUBMITTED', 'CANCELLED'], path: () => '/legal/notices',
  },
  INSPECTION: {
    table: 'compliance_inspections', title: 'inspection_type', date: 'scheduled_at', timed: true,
    description: 'findings', location: 'location', ownerIds: ['responsible_person_id', 'created_by'],
    terminal: ['COMPLETED', 'CANCELLED'], path: () => '/legal/inspections',
  },
  LICENCE_EXPIRY: {
    table: 'compliance_licences', title: 'name', date: 'expiry_date', timed: false,
    description: 'notes', ownerIds: ['responsible_person_id', 'created_by'],
    terminal: ['COMPLETED', 'CANCELLED'], path: () => '/compliance/licences',
  },
});

export const normalizeEventType = (value) => {
  const key = String(value || '').trim().toUpperCase();
  return EVENT_SOURCES[key] ? key : null;
};

export async function loadEventSource(organizationId, eventType, sourceId, db = pool) {
  const type = normalizeEventType(eventType);
  const config = type ? EVENT_SOURCES[type] : null;
  if (!config) return null;
  const { rows } = await db.query(
    `SELECT e.*,s.name AS site_name
       FROM ${config.table} e
       LEFT JOIN sites s ON s.id=e.site_id AND s.organization_id=e.organization_id
      WHERE e.id=$1 AND e.organization_id=$2
      LIMIT 1`,
    [sourceId, organizationId],
  );
  const row = rows[0];
  if (!row) return null;
  const ownerUserIds = [...new Set(config.ownerIds.map((field) => Number(row[field])).filter(Number.isSafeInteger))];
  return {
    ...row,
    event_type: type,
    title: row[config.title],
    event_at: row[config.date],
    timed: config.timed,
    description: config.description ? row[config.description] : null,
    location: config.location ? row[config.location] : null,
    owner_user_ids: ownerUserIds,
    action_path: config.path(row.id),
    cancelled: Boolean(row.deleted_at) || config.terminal.includes(String(row.status || row.renewal_status || '').toUpperCase()),
  };
}

export const sourceDateColumn = (eventType) => EVENT_SOURCES[eventType]?.date;

