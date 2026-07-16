import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 070 — Investor / Partner payout schedule (for the Cash-Flow Forecast).
 *
 * WHY: the Predictive Cash-Flow Forecast needs an OUTFLOW stream for investor/partner payouts
 * (fixed interest / profit-sharing). No such data existed anywhere in the schema — investors were
 * only ever an inert category label. This adds the smallest forward-dated schedule table that lets
 * the forecast project those payouts. Reuses existing `members` (member_type='PARTNER') as the
 * investor, but a free-text investor_name is allowed so a payout can be entered without a member.
 *
 * SAFETY: additive, idempotent (CREATE TABLE IF NOT EXISTS), no changes to existing tables.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS investor_payouts (
        id             SERIAL PRIMARY KEY,
        site_id        INTEGER NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
        member_id      INTEGER          REFERENCES members(id) ON DELETE SET NULL,
        investor_name  VARCHAR(255),
        note           TEXT,
        amount         NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
        due_date       DATE NOT NULL,
        -- 'once' = one-off on due_date; 'monthly'/'quarterly' recur from due_date across the horizon.
        frequency      VARCHAR(20) NOT NULL DEFAULT 'once'
                         CHECK (frequency IN ('once', 'monthly', 'quarterly')),
        payout_type    VARCHAR(20) NOT NULL DEFAULT 'interest'
                         CHECK (payout_type IN ('interest', 'profit_share', 'principal', 'other')),
        status         VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                         CHECK (status IN ('scheduled', 'paid', 'cancelled')),
        paid_at        TIMESTAMPTZ,
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_investor_payouts_site   ON investor_payouts (site_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_investor_payouts_due    ON investor_payouts (due_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_investor_payouts_active ON investor_payouts (site_id, status) WHERE status = 'scheduled'`);

    await client.query('COMMIT');
    console.log('Migration 070_investor_payouts complete (investor_payouts table + indexes)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration 070_investor_payouts failed (rolled back):', err.message);
    throw err;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
