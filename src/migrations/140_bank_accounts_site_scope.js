import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Make configured bank accounts site-owned.
 *
 * Historical bank accounts were firm-global. If one old account is mapped to
 * entries from several sites, keep the original account for the first site,
 * clone it for each additional site, and move only that site's mappings to the
 * clone. This preserves every ledger mapping while establishing the invariant
 * that a cash-flow row can reference only a bank from its own site.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('140_bank_accounts_site_scope'))`);

    await client.query(`
      ALTER TABLE bank_accounts
      ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE RESTRICT
    `);

    // The old firm-wide unique name prevents the per-site copies below.
    await client.query('DROP INDEX IF EXISTS uq_bank_accounts_name');

    const { rows: banks } = await client.query(`
      SELECT id, site_id, name, account_no, ifsc, branch, account_holder,
             notes, is_active, created_by
        FROM bank_accounts
       ORDER BY id
       FOR UPDATE
    `);

    for (const bank of banks) {
      const { rows: usages } = await client.query(
        `SELECT DISTINCT site_id
           FROM cash_flow_entries
          WHERE bank_account_id = $1 AND site_id IS NOT NULL
          ORDER BY site_id`,
        [bank.id]
      );

      let primarySiteId = Number(bank.site_id) || Number(usages[0]?.site_id) || null;
      if (!primarySiteId) {
        const { rows: fallbacks } = await client.query(
          `SELECT s.id
             FROM sites s
             LEFT JOIN users u ON u.id = $1
            WHERE s.organization_id = COALESCE(u.organization_id, 1)
            ORDER BY s.id
            LIMIT 1`,
          [bank.created_by]
        );
        primarySiteId = Number(fallbacks[0]?.id) || null;
      }
      if (!primarySiteId) {
        throw new Error(`Cannot assign bank account ${bank.id} to a site because no site exists`);
      }

      await client.query('UPDATE bank_accounts SET site_id = $2 WHERE id = $1', [bank.id, primarySiteId]);

      for (const usage of usages) {
        const usageSiteId = Number(usage.site_id);
        if (usageSiteId === primarySiteId) continue;
        const { rows: copies } = await client.query(
          `INSERT INTO bank_accounts
             (site_id, name, account_no, ifsc, branch, account_holder, notes,
              is_active, created_by, created_at, updated_at)
           SELECT $2, name, account_no, ifsc, branch, account_holder, notes,
                  is_active, created_by, created_at, NOW()
             FROM bank_accounts
            WHERE id = $1
           RETURNING id`,
          [bank.id, usageSiteId]
        );
        await client.query(
          `UPDATE cash_flow_entries
              SET bank_account_id = $1, updated_at = NOW()
            WHERE bank_account_id = $2 AND site_id = $3`,
          [copies[0].id, bank.id, usageSiteId]
        );
      }
    }

    const { rows: invalid } = await client.query(`
      SELECT COUNT(*)::int AS count
        FROM cash_flow_entries cfe
        JOIN bank_accounts ba ON ba.id = cfe.bank_account_id
       WHERE cfe.site_id IS DISTINCT FROM ba.site_id
    `);
    if (invalid[0].count > 0) {
      throw new Error(`${invalid[0].count} bank mappings still cross site boundaries`);
    }

    await client.query('ALTER TABLE bank_accounts ALTER COLUMN site_id SET NOT NULL');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_accounts_site_name
        ON bank_accounts (site_id, UPPER(TRIM(name)))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_accounts_site_active_name
        ON bank_accounts (site_id, is_active, name)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION enforce_cash_flow_bank_site()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.bank_account_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM bank_accounts ba
           WHERE ba.id = NEW.bank_account_id AND ba.site_id = NEW.site_id
        ) THEN
          RAISE EXCEPTION 'Bank account % does not belong to site %', NEW.bank_account_id, NEW.site_id
            USING ERRCODE = '23514', CONSTRAINT = 'cash_flow_bank_same_site';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_cash_flow_bank_same_site ON cash_flow_entries');
    await client.query(`
      CREATE CONSTRAINT TRIGGER trg_cash_flow_bank_same_site
      AFTER INSERT OR UPDATE OF bank_account_id, site_id ON cash_flow_entries
      DEFERRABLE INITIALLY IMMEDIATE
      FOR EACH ROW EXECUTE FUNCTION enforce_cash_flow_bank_site()
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_mapped_bank_site_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.site_id IS DISTINCT FROM OLD.site_id AND EXISTS (
          SELECT 1 FROM cash_flow_entries cfe
           WHERE cfe.bank_account_id = OLD.id AND cfe.site_id IS DISTINCT FROM NEW.site_id
        ) THEN
          RAISE EXCEPTION 'Mapped bank account % cannot be moved to another site', OLD.id
            USING ERRCODE = '23514', CONSTRAINT = 'mapped_bank_site_immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query('DROP TRIGGER IF EXISTS trg_mapped_bank_site_immutable ON bank_accounts');
    await client.query(`
      CREATE TRIGGER trg_mapped_bank_site_immutable
      BEFORE UPDATE OF site_id ON bank_accounts
      FOR EACH ROW EXECUTE FUNCTION prevent_mapped_bank_site_change()
    `);

    await client.query('COMMIT');
    console.log('Migration 140: bank accounts are site-scoped');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 140 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
