export function nocRegistryDate(value, current) {
  if (value === undefined) {
    // PostgreSQL DATE values can arrive as local-midnight Date objects. Keep
    // the calendar date instead of shifting it when JSON converts to UTC.
    if (current instanceof Date) return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    return current || null;
  }
  if (value === null || value === '') return null;
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw Object.assign(new Error('Enter a valid registry date.'), { statusCode: 400, code: 'INVALID_REGISTRY_DATE' });
  }
  return value;
}
