// Optional compliance times are stored with the record's existing metadata.
// The calendar uses Indian business dates and wall-clock times.
export const normalizeOptionalEventTime = (value) => {
  if (value === null || value === '') return null;
  const time = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw Object.assign(new Error('Invalid event time. Use HH:MM.'), { statusCode: 400 });
  }
  return time;
};

export const complianceEventInstant = (row) => {
  const time = row.metadata?.event_time;
  if (!time || !row.current_due_date) return null;
  normalizeOptionalEventTime(time);
  const value = row.current_due_date;
  // node-postgres DATE values use local midnight; retain their calendar fields.
  const date = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);
  return new Date(`${date}T${time}:00+05:30`);
};
