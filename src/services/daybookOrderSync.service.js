/**
 * One presentation sequence, two storage layers.
 *
 * `daybook_global_order` holds the cross-date sequence users arrange in the
 * period statements; `daybook_entry_order` holds each day's order for the
 * daily view (which also lists pending entries the ledger view excludes).
 * Every save writes its own layer and projects into the other, so both views
 * agree. Readers and the base every save edits share SEQUENCE_ORDER_BY.
 */

export const LEDGER_ENTRY_KEY_SQL = "CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1)))";

/**
 * Saved cross-date positions first. An entry that has never been positioned
 * slots in by date: just above its date's first positioned entry, else just
 * above the first positioned entry of an older date, else at the end.
 * Expects columns global_display_position, display_position, entry_date,
 * transaction_time, created_at, id.
 */
export const SEQUENCE_ORDER_BY = `
  ORDER BY COALESCE(
             global_display_position::numeric,
             COALESCE(
               MIN(global_display_position) OVER (PARTITION BY entry_date),
               MIN(global_display_position) OVER (ORDER BY entry_date DESC RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING)
             ) - 0.5
           ) ASC NULLS LAST,
           entry_date DESC,
           display_position ASC NULLS LAST,
           transaction_time DESC NULLS LAST,
           created_at DESC,
           id DESC`;

const mergeUnique = (...groups) => {
  const seen = new Set();
  const output = [];
  groups.flat().forEach((key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    output.push(key);
  });
  return output;
};

/** Place `desiredKeys` (in their new order) into the slots they occupy in `currentKeys`. */
export const replaceScopedOrder = (currentKeys, desiredKeys) => {
  const desiredSet = new Set(desiredKeys);
  let index = 0;
  return currentKeys.map((key) => (desiredSet.has(key) ? desiredKeys[index++] : key));
};

const sameSequence = (a, b) => a.length === b.length && a.every((key, index) => key === b[index]);

/** The site's full sequence as readers show it: [{ entry_key, entry_date }]. */
export async function loadGlobalSequence(client, siteId) {
  const { rows } = await client.query(
    `SELECT ordered.entry_key, TO_CHAR(ordered.entry_date, 'YYYY-MM-DD') AS entry_date
       FROM (
         SELECT
           ${LEDGER_ENTRY_KEY_SQL} AS entry_key,
           MIN(dgo.position) AS global_display_position,
           MIN(dbo.position) AS display_position,
           MAX(le.entry_date) AS entry_date,
           MAX(cfe.transaction_time) AS transaction_time,
           MAX(le.created_at) AS created_at,
           MAX(le.id) AS id
         FROM ledger_entries le
         LEFT JOIN cash_flow_entries cfe ON cfe.id = SPLIT_PART(le.id, ':', 1)::int
         LEFT JOIN daybook_global_order dgo
           ON dgo.site_id = le.site_id AND dgo.entry_key = ${LEDGER_ENTRY_KEY_SQL}
         LEFT JOIN daybook_entry_order dbo
           ON dbo.site_id = le.site_id AND dbo.entry_date = le.entry_date AND dbo.entry_key = ${LEDGER_ENTRY_KEY_SQL}
        WHERE le.site_id = $1
        GROUP BY 1
       ) ordered
       ${SEQUENCE_ORDER_BY}`,
    [siteId]
  );
  return rows;
}

/**
 * After a cross-date save: rewrite each touched date's per-date order from the
 * final sequence. Pending entries (absent from the ledger view) keep their
 * slots. Three statements regardless of how many dates changed.
 */
export async function projectDatesFromGlobal(client, { siteId, sequence, dates, userId }) {
  const dateList = [...dates].filter(Boolean);
  if (dateList.length === 0) return [];
  const { rows: savedRows } = await client.query(
    `SELECT TO_CHAR(entry_date, 'YYYY-MM-DD') AS entry_date, entry_key
       FROM daybook_entry_order
      WHERE site_id = $1 AND entry_date = ANY($2::date[])
      ORDER BY entry_date, position, entry_key`,
    [siteId, dateList]
  );
  const savedByDate = new Map();
  savedRows.forEach((row) => {
    if (!savedByDate.has(row.entry_date)) savedByDate.set(row.entry_date, []);
    savedByDate.get(row.entry_date).push(row.entry_key);
  });
  const ledgerByDate = new Map();
  sequence.forEach((row) => {
    if (!dates.has(row.entry_date)) return;
    if (!ledgerByDate.has(row.entry_date)) ledgerByDate.set(row.entry_date, []);
    ledgerByDate.get(row.entry_date).push(row.entry_key);
  });

  const tupleDates = [];
  const tupleKeys = [];
  const tuplePositions = [];
  const changedDates = [];
  for (const date of dateList) {
    const saved = savedByDate.get(date) || [];
    const ledger = ledgerByDate.get(date) || [];
    const ordered = replaceScopedOrder(mergeUnique(saved, ledger), ledger);
    if (ordered.length === 0 || sameSequence(ordered, saved)) continue;
    changedDates.push(date);
    ordered.forEach((key, index) => {
      tupleDates.push(date);
      tupleKeys.push(key);
      tuplePositions.push(index + 1);
    });
  }
  if (changedDates.length === 0) return [];

  await client.query(
    `INSERT INTO daybook_entry_order (site_id, entry_date, entry_key, position, updated_by, updated_at)
     SELECT $1, t.entry_date, t.entry_key, t.position, $2, NOW()
       FROM unnest($3::date[], $4::text[], $5::int[]) AS t(entry_date, entry_key, position)
     ON CONFLICT (site_id, entry_date, entry_key) DO UPDATE
       SET position = EXCLUDED.position,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at
     WHERE daybook_entry_order.position IS DISTINCT FROM EXCLUDED.position`,
    [siteId, userId, tupleDates, tupleKeys, tuplePositions]
  );
  await client.query(
    `INSERT INTO daybook_order_state (site_id, entry_date, revision, updated_by, updated_at)
     SELECT $1, d, 1, $2, NOW() FROM unnest($3::date[]) AS d
     ON CONFLICT (site_id, entry_date) DO UPDATE
       SET revision = daybook_order_state.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [siteId, userId, changedDates]
  );
  return changedDates;
}

/**
 * After a per-date save: place that day's ledger entries, in their new
 * relative order, into the slots they hold in the cross-date sequence.
 * Returns the number of positions rewritten (0 when the order already agreed).
 */
export async function projectGlobalFromDate(client, { siteId, orderedKeys, userId }) {
  const sequence = await loadGlobalSequence(client, siteId);
  const base = sequence.map((row) => row.entry_key);
  const baseSet = new Set(base);
  const desired = orderedKeys.filter((key) => baseSet.has(key));
  if (desired.length < 2) return 0;
  const ordered = replaceScopedOrder(base, desired);
  if (sameSequence(ordered, base)) return 0;

  const { rowCount } = await client.query(
    `INSERT INTO daybook_global_order (site_id, entry_key, position, updated_by, updated_at)
     SELECT $1, o.entry_key, o.position::int, $2, NOW()
       FROM unnest($3::text[]) WITH ORDINALITY AS o(entry_key, position)
     ON CONFLICT (site_id, entry_key) DO UPDATE
       SET position = EXCLUDED.position,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at
     WHERE daybook_global_order.position IS DISTINCT FROM EXCLUDED.position`,
    [siteId, userId, ordered]
  );
  if (rowCount === 0) return 0;
  await client.query(
    `INSERT INTO daybook_global_order_state (site_id, revision, updated_by, updated_at)
     VALUES ($1, 1, $2, NOW())
     ON CONFLICT (site_id) DO UPDATE
       SET revision = daybook_global_order_state.revision + 1,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [siteId, userId]
  );
  return rowCount;
}
