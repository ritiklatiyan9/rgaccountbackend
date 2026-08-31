import pool from '../config/db.js';

/**
 * Compatibility lookup for callers that used to post approved debits here.
 *
 * Imprest expense rows are now reconciled atomically by the database from the
 * owning cash-flow row. Keeping this function read-only lets older controller
 * paths observe that posting without racing or double-posting it.
 */
async function findDbOwnedPosting({
  createdBy,
  referenceId,
  sourceModule,
  siteId,
}, type, db) {
  if (!createdBy || !referenceId || !sourceModule || !siteId) return null;

  const result = await db.query(
    `SELECT *
       FROM imprest_ledger
      WHERE user_id = $1
        AND site_id = $2
        AND source_module = $3
        AND reference_id = $4
        AND type = $5
      ORDER BY id DESC
      LIMIT 1`,
    [Number(createdBy), Number(siteId), sourceModule, Number(referenceId), type]
  );
  return result.rows[0] || null;
}

export async function postApprovedImprestDebit(identity, db = pool) {
  return findDbOwnedPosting(identity, 'EXPENSE', db);
}

/**
 * Compatibility lookup after a rejection, edit, or delete. The database owns
 * the restoring adjustment; this function only observes it.
 */
export async function reverseApprovedImprestDebit(identity, db = pool) {
  return findDbOwnedPosting(identity, 'ADJUSTMENT', db);
}
