import pool from '../config/db.js';

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const constraints = await client.query(`
      SELECT DISTINCT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
       WHERE n.nspname = 'public'
         AND t.relname = 'expenses'
         AND c.contype = 'c'
         AND a.attname = 'status'
    `);

    for (const { conname } of constraints.rows) {
      const safeName = String(conname).replace(/"/g, '""');
      await client.query(`ALTER TABLE expenses DROP CONSTRAINT "${safeName}"`);
    }

    await client.query(`
      ALTER TABLE expenses
      ADD CONSTRAINT expenses_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'waiting', 'returned'))
    `);

    await client.query('COMMIT');
    console.log('Expense waiting/returned statuses are ready.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Expense waiting-status migration failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

run();
