import pool from '../config/db.js';

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

try {
  const tablesResult = await pool.query(`
    SELECT columns.table_name
      FROM information_schema.columns AS columns
      JOIN information_schema.tables AS tables
        ON tables.table_schema = columns.table_schema
       AND tables.table_name = columns.table_name
     WHERE columns.table_schema = 'public'
       AND columns.column_name = 'cheque_status'
       AND tables.table_type = 'BASE TABLE'
     ORDER BY columns.table_name
  `);

  const results = [];
  for (const { table_name: table } of tablesResult.rows) {
    const columnsResult = await pool.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
          AND column_name IN ('created_at', 'cheque_status_updated_at')`,
      [table],
    );
    const columns = new Set(columnsResult.rows.map((row) => row.column_name));
    const triggerName = `trg_${table}_cheque_status_timestamp`;
    const triggerResult = await pool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_trigger
          WHERE tgrelid = to_regclass($1)
            AND tgname = $2
            AND NOT tgisinternal
       ) AS present`,
      [`public.${table}`, triggerName],
    );

    let chequeRows = null;
    let missingStatusDates = null;
    if (columns.has('cheque_status_updated_at')) {
      const countsResult = await pool.query(`
        SELECT COUNT(*) FILTER (WHERE cheque_status IS NOT NULL)::int AS cheque_rows,
               COUNT(*) FILTER (
                 WHERE cheque_status IS NOT NULL
                   AND cheque_status_updated_at IS NULL
               )::int AS missing_status_dates
          FROM ${quoteIdentifier(table)}
      `);
      ({ cheque_rows: chequeRows, missing_status_dates: missingStatusDates } = countsResult.rows[0]);
    }

    results.push({
      table,
      created_at: columns.has('created_at'),
      status_timestamp: columns.has('cheque_status_updated_at'),
      timestamp_trigger: triggerResult.rows[0].present,
      cheque_rows: chequeRows,
      missing_status_dates: missingStatusDates,
    });
  }

  console.table(results);
  const failures = results.filter((row) => (
    !row.created_at
    || !row.status_timestamp
    || !row.timestamp_trigger
    || row.missing_status_dates !== 0
  ));
  if (failures.length) {
    throw new Error(`Transaction-date audit failed for: ${failures.map((row) => row.table).join(', ')}`);
  }

  await pool.query('BEGIN');
  try {
    await pool.query(`
      CREATE TEMP TABLE transaction_date_trigger_probe (
        id SERIAL PRIMARY KEY,
        payment_mode TEXT,
        cheque_status TEXT,
        cheque_status_updated_at TIMESTAMPTZ,
        note TEXT
      ) ON COMMIT DROP
    `);
    await pool.query(`
      CREATE TRIGGER transaction_date_trigger_probe_stamp
      BEFORE INSERT OR UPDATE OF cheque_status ON transaction_date_trigger_probe
      FOR EACH ROW EXECUTE FUNCTION stamp_cheque_status_updated_at()
    `);
    const insertResult = await pool.query(`
      INSERT INTO transaction_date_trigger_probe (payment_mode, cheque_status)
      VALUES ('CASH', NULL), ('CHEQUE', 'PENDING')
      RETURNING id, payment_mode, cheque_status_updated_at
    `);
    const cashRow = insertResult.rows.find((row) => row.payment_mode === 'CASH');
    const chequeRow = insertResult.rows.find((row) => row.payment_mode === 'CHEQUE');
    if (cashRow.cheque_status_updated_at !== null || !chequeRow.cheque_status_updated_at) {
      throw new Error('Trigger probe failed while stamping inserted rows');
    }

    await pool.query(
      `UPDATE transaction_date_trigger_probe
          SET cheque_status_updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00'
        WHERE id = $1`,
      [chequeRow.id],
    );
    await pool.query(
      `UPDATE transaction_date_trigger_probe SET note = 'unrelated edit' WHERE id = $1`,
      [chequeRow.id],
    );
    const unrelatedEditResult = await pool.query(
      `SELECT cheque_status_updated_at = TIMESTAMPTZ '2000-01-01 00:00:00+00' AS unchanged
         FROM transaction_date_trigger_probe WHERE id = $1`,
      [chequeRow.id],
    );
    if (!unrelatedEditResult.rows[0].unchanged) {
      throw new Error('An unrelated edit changed the cheque transaction timestamp');
    }

    const statusEditResult = await pool.query(
      `UPDATE transaction_date_trigger_probe
          SET cheque_status = 'CLEARED'
        WHERE id = $1
      RETURNING cheque_status_updated_at > TIMESTAMPTZ '2000-01-01 00:00:00+00' AS restamped`,
      [chequeRow.id],
    );
    if (!statusEditResult.rows[0].restamped) {
      throw new Error('A cheque status change did not refresh its transaction timestamp');
    }
  } finally {
    await pool.query('ROLLBACK');
  }

  console.log(`Transaction-date audit passed for ${results.length} cheque-enabled tables.`);
  console.log('Trigger behavior passed: cash unchanged, cheque status changes restamped, unrelated edits ignored.');
} finally {
  await pool.end();
}
