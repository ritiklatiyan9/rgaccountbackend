import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';

const DYNAMIC_TABLES = Object.freeze({
  plot_installment_payments: 'plot_installment_payments',
  vendor_payments: 'vendor_payments',
  plot_commission_payments: 'plot_commission_payments',
  plot_registry_payments: 'plot_registry_payments',
});

/**
 * Protect a direct entry URL from ID guessing. List endpoints already apply a
 * creator predicate; this middleware applies the same policy to get/edit/delete.
 * Static table names come from route code, while dynamic module names are
 * resolved only through the fixed whitelist above.
 */
export const requireEntryCreatorAccess = ({ module, table, sourceParam = null, idParam = 'id' }) => asyncHandler(async (req, res, next) => {
  const entryId = Number.parseInt(req.params[idParam], 10);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return res.status(400).json({ message: 'Invalid entry id' });
  }

  const resolvedTable = sourceParam ? DYNAMIC_TABLES[req.params[sourceParam]] : table;
  if (!resolvedTable) return res.status(400).json({ message: 'Unsupported module source' });

  const visibility = await resolveEntryVisibility(req.user, module, null);
  if (visibility.canViewAll) return next();

  const { rows } = await pool.query(
    `SELECT created_by FROM ${resolvedTable} WHERE id = $1 LIMIT 1`,
    [entryId]
  );
  if (!rows[0] || Number(rows[0].created_by) !== Number(visibility.creatorId)) {
    return res.status(404).json({ message: 'Entry not found' });
  }
  return next();
});

/** Site-wide ordering changes every user's presentation and therefore needs
 * the module's All Entries scope, not only update permission. */
export const requireAllEntryVisibility = (module) => asyncHandler(async (req, res, next) => {
  const visibility = await resolveEntryVisibility(req.user, module, null);
  if (!visibility.canViewAll) {
    return res.status(403).json({ message: 'All Entries permission is required for this action' });
  }
  return next();
});

