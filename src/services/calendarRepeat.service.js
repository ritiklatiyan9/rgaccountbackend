import { dateKey, parseDate } from './complianceEngine.service.js';

export function monthlyCalendarRule(enabled, dueDate, until) {
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw Object.assign(new Error('Repeat monthly must be on or off'), { statusCode: 400 });
  }
  if (!enabled) return null;
  const start = parseDate(dueDate);
  const end = until ? parseDate(until) : null;
  if (!start) throw Object.assign(new Error('A date is required for a repeating event'), { statusCode: 400 });
  if (until && (!end || end < start)) {
    throw Object.assign(new Error('Repeat until must be a valid date on or after the first event'), { statusCode: 400 });
  }
  const monthStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const through = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
  return { startDate: dateKey(monthStart), endDate: end ? dateKey(end) : null,
    throughDate: dateKey(through), dueDateRule: { type: 'FIXED_DAY_OF_MONTH', day: start.getUTCDate() } };
}

export function calendarTemplateDefaults(template) {
  const defaults = template.calendar_event_defaults || {};
  return { title: defaults.title || template.name, priority: defaults.priority || template.default_risk,
    metadata: defaults.metadata || {} };
}
