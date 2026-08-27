import pool from '../config/db.js';

const normalizedAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
};

/**
 * Post a sub-admin's approved debit to their imprest exactly once.
 * sourceModule is part of the identity because ids can overlap across tables.
 */
export async function postApprovedImprestDebit({
  createdBy,
  amount,
  referenceId,
  sourceModule,
  remarks,
  approvedBy,
  siteId,
  proofKey,
}, db = pool) {
  const debit = normalizedAmount(amount);
  if (!createdBy || !referenceId || !sourceModule || !siteId || debit === 0) return null;

  const result = await db.query(
    `WITH removed_reversal AS (
       DELETE FROM imprest_ledger
        WHERE user_id = $1
          AND site_id = $6
          AND source_module = $7
          AND reference_id = $2
          AND type = 'ADJUSTMENT'
       RETURNING id
     )
     INSERT INTO imprest_ledger (
       user_id, type, reference_id, amount, remarks, created_by,
       site_id, source_module, proof_key, balance_after
     )
     SELECT $1, 'EXPENSE', $2, -$3::numeric, UPPER($4), $5, $6, $7, $8,
            COALESCE((
              SELECT SUM(il.amount)
                FROM imprest_ledger il
               WHERE il.user_id = $1 AND il.site_id = $6
            ), 0) - $3::numeric
       FROM users u
      WHERE u.id = $1 AND u.role = 'sub_admin'
     ON CONFLICT (user_id, site_id, source_module, reference_id, type)
       WHERE source_module IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      Number(createdBy), Number(referenceId), debit,
      remarks || `${sourceModule} #${referenceId}`, approvedBy || null,
      Number(siteId), sourceModule, proofKey || null,
    ]
  );
  return result.rows[0] || null;
}

/** Reverse a previously posted imprest debit exactly once. */
export async function reverseApprovedImprestDebit({
  createdBy,
  amount,
  referenceId,
  sourceModule,
  remarks,
  reversedBy,
  siteId,
}, db = pool) {
  const debit = normalizedAmount(amount);
  if (!createdBy || !referenceId || !sourceModule || !siteId || debit === 0) return null;

  const result = await db.query(
    `INSERT INTO imprest_ledger (
       user_id, type, reference_id, amount, remarks, created_by,
       site_id, source_module, balance_after
     )
     SELECT $1, 'ADJUSTMENT', $2, $3::numeric, UPPER($4), $5, $6, $7,
            COALESCE((
              SELECT SUM(il.amount)
                FROM imprest_ledger il
               WHERE il.user_id = $1 AND il.site_id = $6
            ), 0) + $3::numeric
      WHERE EXISTS (
        SELECT 1
          FROM imprest_ledger posted
         WHERE posted.user_id = $1
           AND posted.site_id = $6
           AND posted.source_module = $7
           AND posted.reference_id = $2
           AND posted.type = 'EXPENSE'
           AND posted.amount < 0
      )
     ON CONFLICT (user_id, site_id, source_module, reference_id, type)
       WHERE source_module IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      Number(createdBy), Number(referenceId), debit,
      `REVERSED (REJECTED): ${remarks || `${sourceModule} #${referenceId}`}`,
      reversedBy || null, Number(siteId), sourceModule,
    ]
  );
  return result.rows[0] || null;
}
