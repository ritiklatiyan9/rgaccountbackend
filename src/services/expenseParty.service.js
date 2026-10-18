import pool from '../config/db.js';

const invalidParty = (message, statusCode = 400) => Object.assign(new Error(message), {
  statusCode,
  code: 'INVALID_EXPENSE_PARTY',
});

const memberIdFrom = (value) => {
  if (value === null || value === '') return null;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))
    || Number(value) < 1 || Number(value) > 2147483647) {
    throw invalidParty('Choose a valid linked client');
  }
  return Number(value);
};

/**
 * The optional client is part of an expense save. Keep both writes on the same
 * connection so a rejected or interrupted link can never leave a saved expense
 * that appears to have accepted the selected client.
 */
export async function saveExpenseWithParty({ siteId, memberId: rawMemberId, userId, write }, database = pool) {
  const memberId = memberIdFrom(rawMemberId);
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    let member = null;
    if (memberId) {
      const { rows } = await db.query(
        'SELECT id, full_name, phone FROM members WHERE id = $1 AND site_id = $2 FOR KEY SHARE',
        [memberId, siteId]
      );
      member = rows[0];
      if (!member) throw invalidParty('Choose a client from the same site as this expense', 409);
    }

    const expense = await write(db);
    if (!expense) throw Object.assign(new Error('Expense not found'), { statusCode: 404 });
    const direction = Number(expense.debit) > 0 ? 'debit' : 'credit';
    if (member) {
      await db.query(
        `INSERT INTO transaction_party_links (source_key, source_id, site_id, member_id, direction, created_by)
         VALUES ('expense', $1, $2, $3, $4, $5)
         ON CONFLICT (source_key, source_id) DO UPDATE
           SET site_id = EXCLUDED.site_id, member_id = EXCLUDED.member_id,
               direction = EXCLUDED.direction, updated_at = NOW()`,
        [expense.id, siteId, member.id, direction, userId]
      );
    } else {
      await db.query(
        "DELETE FROM transaction_party_links WHERE source_key = 'expense' AND source_id = $1",
        [expense.id]
      );
    }
    await db.query('COMMIT');
    return {
      ...expense,
      related_party: member
        ? { member_id: member.id, name: member.full_name, phone: member.phone, direction }
        : null,
    };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function attachExpenseParty(expense, database = pool) {
  const { rows } = await database.query(
    `SELECT l.member_id, m.full_name AS name, m.phone, l.direction
       FROM transaction_party_links l
       JOIN members m ON m.id = l.member_id AND m.site_id = l.site_id
      WHERE l.source_key = 'expense' AND l.source_id = $1 AND l.site_id = $2`,
    [expense.id, expense.site_id]
  );
  return { ...expense, related_party: rows[0] || null };
}
