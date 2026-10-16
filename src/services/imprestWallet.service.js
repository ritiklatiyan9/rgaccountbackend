import pool from '../config/db.js';

// Match the selected site's wallet balance exactly. The organization balance
// is checked separately by the permanent wallet debit guard at posting time.
export async function getImprestWalletBalance(userId, siteId, db = pool) {
  const { rows: [row] } = await db.query(`SELECT COALESCE(sum(e.amount),0) AS balance
    FROM loyalty_vault_entries e JOIN users u ON u.id=$1 AND u.organization_id=e.organization_id
    JOIN sites s ON s.id=$2 AND s.organization_id=u.organization_id
    WHERE e.holder_key='user:'||u.id::text AND e.site_id=s.id`, [userId, siteId]);
  const balance = Number(row?.balance || 0);
  return { balance, posted_balance: balance, available_balance: balance, reserved_amount: 0, balance_source: 'CASH_WALLET' };
}

export async function getSiteImprestWallet(siteId, db = pool) {
  const { rows: [holder] } = await db.query(`SELECT u.id,u.name FROM users u
    WHERE u.id=imprest_site_wallet_holder($1)`, [siteId]);
  const balance = await getImprestWalletBalance(holder?.id || null, siteId, db);
  return { ...balance, wallet_holder_id: holder?.id || null, wallet_holder_name: holder?.name || null };
}

export async function postImprestWalletMovement(db, { table, id, userId, siteId, amount, actorId, description, counterpartyId, note }) {
  await db.query('SELECT reconcile_imprest_wallet($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [table, id, userId, siteId, amount, actorId, description, counterpartyId || null, note || null]);
}
