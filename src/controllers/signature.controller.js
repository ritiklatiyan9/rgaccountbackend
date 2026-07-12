import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

// One endpoint signs any receipt row. Strict allowlist: target → table +
// permission module. Only the two signature columns are writable here, so
// module-specific validation rules (e.g. vendor's required amount/date)
// stay untouched.
export const SIGN_TARGETS = {
  expense:            { table: 'expenses',                 perm: 'expenses' },
  farmer_payment:     { table: 'farmer_payments',          perm: 'farmers' },
  daybook:            { table: 'day_book',                 perm: 'daybook' },
  vendor_payment:     { table: 'vendor_payments',          perm: 'vendors' },
  plot_payment:       { table: 'plot_payments',            perm: 'plot_payments' },
  registry_payment:   { table: 'plot_registry_payments',   perm: 'plot_registry' },
  commission_payment: { table: 'plot_commission_payments', perm: 'commissions' },
  cashflow_entry:     { table: 'cash_flow_entries',        perm: 'cashflow' },
};

/**
 * PUT /signatures/:target/:id
 * Body: { customer_signature_url?, authority_signature_url? }
 */
export const saveSignatures = asyncHandler(async (req, res) => {
  const target = SIGN_TARGETS[req.params.target];
  if (!target) return res.status(400).json({ message: 'Unknown signature target' });
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid id' });

  const { customer_signature_url, authority_signature_url } = req.body;
  const sets = [];
  const params = [];
  if (customer_signature_url !== undefined) {
    params.push(customer_signature_url || null);
    sets.push(`customer_signature_url = $${params.length}`);
  }
  if (authority_signature_url !== undefined) {
    params.push(authority_signature_url || null);
    sets.push(`authority_signature_url = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  params.push(id);

  const result = await pool.query(
    `UPDATE ${target.table} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`,
    params
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Record not found' });
  res.json({ message: 'Signatures saved', id: result.rows[0].id });
});
