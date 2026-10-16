import pool from '../config/db.js';
import { listModuleVisibility, setModuleVisibility } from './moduleVisibility.service.js';

export const isWalletAdmin = actor => ['admin', 'super_admin'].includes(actor.role);
// A viewing grant never changes the actor's role, site access or transfer rights.
export const canViewAllWallets = actor => isWalletAdmin(actor) || actor.wallet_view_all === true;

export async function withWalletVisibility(actor, database = pool) {
  if (isWalletAdmin(actor)) return actor;
  const { rows } = await database.query(
    "SELECT can_read, can_view_all FROM user_permissions WHERE user_id=$1 AND module='wallet'",
    [actor.id]
  );
  return { ...actor, wallet_can_read: rows[0]?.can_read !== false,
    wallet_view_all: rows[0]?.can_read === true && rows[0]?.can_view_all === true };
}

export async function listWalletVisibility(actor, database = pool) {
  return (await listModuleVisibility(actor, 'wallet', database)).map(({ view_all, ...user }) => ({ ...user, view_all_wallets: view_all }));
}

export async function setWalletVisibility(actor, userId, enabled, database = pool) {
  const { user_id, view_all } = await setModuleVisibility(actor, 'wallet', userId, enabled, database);
  return { user_id, view_all_wallets: view_all };
}
