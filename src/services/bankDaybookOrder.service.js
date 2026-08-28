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

const replaceScopedOrder = (currentKeys, desiredKeys) => {
  const desiredSet = new Set(desiredKeys);
  let index = 0;
  return currentKeys.map((key) => (
    desiredSet.has(key) ? desiredKeys[index++] : key
  ));
};

const conflict = (message, code, extra = {}) => Object.assign(new Error(message), {
  statusCode: 409,
  code,
  ...extra,
});

/**
 * Applies a bank-statement sequence to both order layers in one transaction.
 * Accounting rows, dates, amounts, and bank mappings are never modified.
 */
export async function applyBankDaybookOrder(client, {
  siteId,
  canonicalMatches,
  userId,
  requestId,
  expectedGlobalRevision,
}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daybook-global-order:${siteId}`]);
  await client.query(
    `INSERT INTO daybook_global_order_state (site_id)
     VALUES ($1)
     ON CONFLICT (site_id) DO NOTHING`,
    [siteId]
  );
  const globalState = (await client.query(
    `SELECT revision, last_request_id
       FROM daybook_global_order_state
      WHERE site_id = $1
      FOR UPDATE`,
    [siteId]
  )).rows[0];
  const currentGlobalRevision = Number(globalState.revision) || 0;
  if (requestId && globalState.last_request_id === requestId) {
    return {
      already_applied: true,
      order_revision: currentGlobalRevision,
      changed: 0,
      dates: 0,
    };
  }
  if (Number(expectedGlobalRevision) !== currentGlobalRevision) {
    throw conflict(
      'The Bank Day Book order changed after this preview. Upload the statement again to use the latest entries.',
      'STALE_ORDER_PREVIEW',
      { orderRevision: currentGlobalRevision }
    );
  }

  const desiredByDate = new Map();
  for (const match of canonicalMatches) {
    if (!desiredByDate.has(match.date)) desiredByDate.set(match.date, []);
    desiredByDate.get(match.date).push(match.entry_key);
  }

  let totalChanged = 0;
  const localRevisions = {};
  for (const date of [...desiredByDate.keys()].sort()) {
    const desiredKeys = desiredByDate.get(date);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`daybook-order:${siteId}:${date}`]);
    await client.query(
      `INSERT INTO daybook_order_state (site_id, entry_date)
       VALUES ($1, $2::date)
       ON CONFLICT (site_id, entry_date) DO NOTHING`,
      [siteId, date]
    );
    await client.query(
      `SELECT revision
         FROM daybook_order_state
        WHERE site_id = $1 AND entry_date = $2::date
        FOR UPDATE`,
      [siteId, date]
    );

    const [savedRows, ledgerRows] = await Promise.all([
      client.query(
        `SELECT entry_key
           FROM daybook_entry_order
          WHERE site_id = $1 AND entry_date = $2::date
          ORDER BY position, entry_key`,
        [siteId, date]
      ),
      client.query(
        `SELECT ordered.entry_key
           FROM (
             SELECT
               CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1))) AS entry_key,
               MIN(dbo.position) AS display_position,
               MAX(le.created_at) AS created_at,
               MAX(le.id) AS ledger_id
             FROM ledger_entries le
             LEFT JOIN daybook_entry_order dbo
               ON dbo.site_id = le.site_id
              AND dbo.entry_date = le.entry_date
              AND dbo.entry_key = CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1)))
            WHERE le.site_id = $1 AND le.entry_date = $2::date
            GROUP BY 1
           ) ordered
          ORDER BY ordered.display_position ASC NULLS LAST,
                   ordered.created_at DESC,
                   ordered.ledger_id DESC`,
        [siteId, date]
      ),
    ]);
    const fullKeys = mergeUnique(
      savedRows.rows.map((row) => row.entry_key),
      ledgerRows.rows.map((row) => row.entry_key)
    );
    const fullKeySet = new Set(fullKeys);
    if (desiredKeys.some((key) => !fullKeySet.has(key))) {
      throw conflict(`One or more matched entries for ${date} are no longer available.`, 'STALE_MATCHED_ENTRY');
    }
    const orderedKeys = replaceScopedOrder(fullKeys, desiredKeys);
    const upserted = await client.query(
      `INSERT INTO daybook_entry_order
         (site_id, entry_date, entry_key, position, updated_by, updated_at)
       SELECT $1, $2::date, ordered.entry_key, ordered.position::int, $3, NOW()
         FROM unnest($4::text[]) WITH ORDINALITY AS ordered(entry_key, position)
       ON CONFLICT (site_id, entry_date, entry_key) DO UPDATE
         SET position = EXCLUDED.position,
             updated_by = EXCLUDED.updated_by,
             updated_at = EXCLUDED.updated_at
       WHERE daybook_entry_order.position IS DISTINCT FROM EXCLUDED.position`,
      [siteId, date, userId, orderedKeys]
    );
    totalChanged += upserted.rowCount;
    const revision = (await client.query(
      `UPDATE daybook_order_state
          SET revision = revision + 1,
              last_request_id = $3,
              updated_by = $4,
              updated_at = NOW()
        WHERE site_id = $1 AND entry_date = $2::date
        RETURNING revision`,
      [siteId, date, requestId, userId]
    )).rows[0];
    localRevisions[date] = Number(revision.revision);
  }

  const [savedGlobalRows, ledgerGlobalRows] = await Promise.all([
    client.query(
      `SELECT entry_key
         FROM daybook_global_order
        WHERE site_id = $1
        ORDER BY position, entry_key`,
      [siteId]
    ),
    client.query(
      `SELECT ordered.entry_key
         FROM (
           SELECT
             CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1))) AS entry_key,
             MIN(dgo.position) AS global_position,
             MIN(dbo.position) AS local_position,
             MAX(le.entry_date) AS entry_date,
             MAX(le.created_at) AS created_at,
             MAX(le.id) AS ledger_id
           FROM ledger_entries le
           LEFT JOIN daybook_global_order dgo
             ON dgo.site_id = le.site_id
            AND dgo.entry_key = CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1)))
           LEFT JOIN daybook_entry_order dbo
             ON dbo.site_id = le.site_id
            AND dbo.entry_date = le.entry_date
            AND dbo.entry_key = CONCAT(le.source_key, ':', COALESCE(le.source_id::text, SPLIT_PART(le.id, ':', 1)))
          WHERE le.site_id = $1
          GROUP BY 1
         ) ordered
        ORDER BY ordered.entry_date DESC,
                 ordered.global_position ASC NULLS LAST,
                 ordered.local_position ASC NULLS LAST,
                 ordered.created_at DESC,
                 ordered.ledger_id DESC`,
      [siteId]
    ),
  ]);
  const fullGlobalKeys = mergeUnique(
    savedGlobalRows.rows.map((row) => row.entry_key),
    ledgerGlobalRows.rows.map((row) => row.entry_key)
  );
  const globalKeySet = new Set(fullGlobalKeys);
  const desiredGlobalKeys = canonicalMatches.map((match) => match.entry_key);
  if (desiredGlobalKeys.some((key) => !globalKeySet.has(key))) {
    throw conflict('One or more matched entries are no longer available.', 'STALE_MATCHED_ENTRY');
  }
  const orderedGlobalKeys = replaceScopedOrder(fullGlobalKeys, desiredGlobalKeys);
  const globalUpsert = await client.query(
    `INSERT INTO daybook_global_order
       (site_id, entry_key, position, updated_by, updated_at)
     SELECT $1, ordered.entry_key, ordered.position::int, $2, NOW()
       FROM unnest($3::text[]) WITH ORDINALITY AS ordered(entry_key, position)
     ON CONFLICT (site_id, entry_key) DO UPDATE
       SET position = EXCLUDED.position,
           updated_by = EXCLUDED.updated_by,
           updated_at = EXCLUDED.updated_at
     WHERE daybook_global_order.position IS DISTINCT FROM EXCLUDED.position`,
    [siteId, userId, orderedGlobalKeys]
  );
  totalChanged += globalUpsert.rowCount;
  const globalRevision = (await client.query(
    `UPDATE daybook_global_order_state
        SET revision = revision + 1,
            last_request_id = $2,
            updated_by = $3,
            updated_at = NOW()
      WHERE site_id = $1
      RETURNING revision`,
    [siteId, requestId, userId]
  )).rows[0];

  return {
    already_applied: false,
    order_revision: Number(globalRevision.revision),
    local_revisions: localRevisions,
    changed: totalChanged,
    dates: desiredByDate.size,
  };
}

