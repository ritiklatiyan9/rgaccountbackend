import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * Migration 166 — "Money Related To": a transaction ↔ client hint.
 *
 * THIS IS A NOTE, NOT A POSTING. The row carries no amount, no payment mode
 * and no status, so nothing in `ledger_entries`, the dashboards, the balance
 * sheet or any module total can read it. Mapping a transaction to a client can
 * therefore never move, net or double-count money — it only answers "who was
 * this about?" beside the row.
 *
 * Keyed polymorphically by (source_key, source_id), reusing the target keys
 * the signature endpoint already defines, so no money table gains a column.
 */
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('166_transaction_party_links'))");

    await db.query(`
      CREATE TABLE IF NOT EXISTS transaction_party_links (
        source_key  VARCHAR(40)  NOT NULL,
        source_id   INTEGER      NOT NULL,
        site_id     INTEGER      NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
        member_id   INTEGER      NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        direction   VARCHAR(6)   NOT NULL CHECK (direction IN ('credit', 'debit')),
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_key, source_id)
      )
    `);

    // The only read pattern: "every link this module has in this site", which a
    // page turns into a plain lookup by row id. Sparse table — unmapped rows
    // cost nothing.
    await db.query(`CREATE INDEX IF NOT EXISTS idx_transaction_party_links_scope
      ON transaction_party_links (source_key, site_id)`);
    // Client detail pages ask the mirror question: "what is mapped to me?"
    await db.query(`CREATE INDEX IF NOT EXISTS idx_transaction_party_links_member
      ON transaction_party_links (member_id)`);

    await db.query(`INSERT INTO app_schema_migrations(version)
      VALUES ('166_transaction_party_links') ON CONFLICT DO NOTHING`);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up()
    .then(() => console.log('Transaction party links ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
