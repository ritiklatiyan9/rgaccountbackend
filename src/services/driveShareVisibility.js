/** Compare permission values, not JSON object key order. Queue requests are
 * stored as JSONB, which can reorder the keys before a worker reads them. */
export const entryVisibilityKey = (visibility) => {
  if (!visibility || typeof visibility.canViewAll !== 'boolean'
    || !Object.hasOwn(visibility, 'creatorId')) return null;
  let creatorIds = null;
  if (visibility.creatorId !== null) {
    const values = Array.isArray(visibility.creatorId)
      ? visibility.creatorId : String(visibility.creatorId).split(',');
    const ids = values.map((value) => String(value).trim());
    if (!ids.length || ids.some((id) => !/^(?:\d+|-1)$/.test(id)
      || !Number.isSafeInteger(Number(id)) || Number(id) === 0 || Number(id) > 2147483647)
      || (ids.length > 1 && ids.includes('-1'))) return null;
    creatorIds = [...new Set(ids.map((id) => String(Number(id))))].sort();
  }
  return JSON.stringify({ canViewAll: visibility.canViewAll, creatorIds });
};

export const sameEntryVisibility = (left, right) => {
  const key = entryVisibilityKey(left);
  return key !== null && key === entryVisibilityKey(right);
};
