import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Retire the legacy Admin personal-float model.
 *
 * Admins now hold the site's custody directly and may distribute only the
 * cash portion that remains after staff floats and pending handovers. Historic
 * Admin ledger rows stay as audit evidence, but their active net balance and
 * source reservations are neutralised exactly once.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('126_cash_only_admin_imprest'))`);

    // Admin reservations no longer represent spendable personal money. Do not
    // broadly reconcile their source keys here: a source may have since moved
    // to a staff owner whose valid debit must remain untouched.
    await client.query(`
      DELETE FROM imprest_debit_reservations r
      USING users u
      WHERE u.id = r.user_id
        AND LOWER(COALESCE(u.role, '')) IN ('admin', 'super_admin')
    `);

    // Keep the old rows for audit, but make every site-scoped Admin ledger net
    // to zero. The stable source key makes this rerunnable without duplicates.
    await client.query(`
      WITH admin_accounts AS (
        SELECT il.user_id,
               il.site_id,
               COALESCE(SUM(il.amount) FILTER (
                 WHERE il.source_module IS DISTINCT FROM 'admin_float_retirement'
               ), 0)::numeric AS legacy_net
          FROM imprest_ledger il
          JOIN users u ON u.id = il.user_id
         WHERE LOWER(COALESCE(u.role, '')) IN ('admin', 'super_admin')
           AND il.site_id IS NOT NULL
         GROUP BY il.user_id, il.site_id
      )
      INSERT INTO imprest_ledger (
        user_id, type, reference_id, amount, balance_after, remarks,
        created_by, site_id, source_module
      )
      SELECT a.user_id,
             'ADJUSTMENT',
             a.user_id,
             -a.legacy_net,
             0,
             'ADMIN PERSONAL FLOAT RETIRED — BALANCE RETURNED TO SITE CUSTODY',
             a.user_id,
             a.site_id,
             'admin_float_retirement'
        FROM admin_accounts a
      ON CONFLICT (user_id, site_id, source_module, reference_id, type)
        WHERE source_module IS NOT NULL
      DO UPDATE SET
        amount = EXCLUDED.amount,
        balance_after = 0,
        remarks = EXCLUDED.remarks,
        created_at = CASE
          WHEN imprest_ledger.amount IS DISTINCT FROM EXCLUDED.amount THEN NOW()
          ELSE imprest_ledger.created_at
        END
    `);

    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('126_cash_only_admin_imprest')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 126_cash_only_admin_imprest complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 126_cash_only_admin_imprest failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
