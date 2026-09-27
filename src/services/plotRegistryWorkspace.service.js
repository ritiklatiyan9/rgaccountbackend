import { registrySizeFromPlot } from '../utils/registrySize.js';
import { registryPaymentFromMetres } from '../utils/registryPayment.js';
import { PLOT_BUYER_MEMBER_JOIN } from './plotMemberLinks.service.js';

/** Ensure the registry backing record in the caller's transaction. Shared by
 * NOC drafts and explicit REGISTRY status saves. It never issues an NOC or
 * invents registry dates; receipts are linked without posting new payments.
 * The plot lock makes repeat/concurrent saves idempotent. */
export async function ensurePlotRegistryWorkspace(client, plotId, createdBy = null) {
  // Lock the plot so two simultaneous NOC opens cannot create two drafts.
  const plotResult = await client.query(
    `SELECT id, site_id, COALESCE(to_jsonb(p)->>'unit_type', 'plot') AS unit_type,
            plot_no, buyer_name, plot_size, plot_size_mtr,
            circle_rate, to_receive_bank, assigned_admin_id, status, plot_tag
       FROM plots p
      WHERE id = $1
      FOR UPDATE`,
    [plotId]
  );
  const plot = plotResult.rows[0];
  if (!plot) {
    throw Object.assign(new Error('Plot not found'), { statusCode: 404, code: 'PLOT_NOT_FOUND' });
  }
  if (String(plot.plot_tag || '').trim().toUpperCase() === 'OLD') {
    throw Object.assign(new Error('Resold (OLD) plots stay out of the registry flow — open the NOC from the current plot record'), { statusCode: 400 });
  }

  const existingResult = await client.query(
    `SELECT id, plot_id, plot_no, noc_generated_at, noc_approved_at,
            registry_payment, updated_at
       FROM plot_registries
      WHERE plot_id = $1
         OR (plot_id IS NULL AND site_id = $2 AND UPPER(plot_no) = UPPER($3))
      ORDER BY CASE WHEN plot_id = $1 THEN 0 ELSE 1 END, updated_at DESC NULLS LAST, id DESC
      LIMIT 1
      FOR UPDATE`,
    [plot.id, plot.site_id, plot.plot_no]
  );
  if (existingResult.rows[0]) {
    return { registry: existingResult.rows[0], created: false };
  }

  const validPaymentsResult = await client.query(
    `SELECT pp.id, pp.date, pp.amount, pp.payment_type, pp.payment_from,
            pp.bank_details, pp.narration, pp.cheque_no, pp.cheque_status,
            pp.status, pp.approved_by, pp.approved_at
       FROM plot_payments pp
      WHERE pp.plot_id = $1
        AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
        AND pp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
      ORDER BY pp.date ASC, pp.created_at ASC`,
    [plot.id]
  );
  const validPayments = validPaymentsResult.rows;
  const { size_sqyard: gaz, size_meter: sizeMetres } = registrySizeFromPlot(plot);
  const registryPayment = registryPaymentFromMetres(sizeMetres, plot.circle_rate) || 0;
  const buyerResult = await client.query(
    `SELECT plot_buyer.full_name AS client_name
       FROM plots p
       ${PLOT_BUYER_MEMBER_JOIN}
      WHERE p.id = $1`,
    [plot.id]
  );
  const customerName = plot.buyer_name || buyerResult.rows[0]?.client_name;

  const registryResult = await client.query(
    `INSERT INTO plot_registries (
       site_id, plot_id, plot_no, customer_name, size_meter, size_sqyard,
       circle_rate, created_entry_date, bank_amount, registry_payment,
       notes, assigned_admin_id, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8, $9, $10, $11, $12)
     RETURNING id, plot_id, plot_no, noc_generated_at, noc_approved_at,
               registry_payment, updated_at`,
    [
      plot.site_id,
      plot.id,
      String(plot.plot_no || '').trim().toUpperCase(),
      customerName ? String(customerName).trim().toUpperCase() : null,
      sizeMetres,
      gaz || null,
      parseFloat(plot.circle_rate) || null,
      parseFloat(plot.to_receive_bank) || 0,
      registryPayment,
      'NOC workspace draft created automatically from Plot Payments.',
      plot.assigned_admin_id || null,
      createdBy,
    ]
  );
  const registry = registryResult.rows[0];

  // Preselect already-approved receipts in the NOC. This is only a mapping
  // to the NOC draft; it never creates a second plot payment.
  for (const payment of validPayments) {
    await client.query(
      `INSERT INTO plot_registry_payments (
         registry_id, site_id, payment_date, amount, payment_mode,
         tally_date, tally_amount, notes, source_plot_payment_id,
         include_in_noc, cheque_no, cheque_status, status,
         approved_by, approved_at, created_by
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, $13, $14, $15
       WHERE NOT EXISTS (
         SELECT 1 FROM plot_registry_payments WHERE source_plot_payment_id = $9
       )`,
      [
        registry.id,
        plot.site_id,
        payment.date,
        parseFloat(payment.amount) || 0,
        String(payment.payment_from || payment.payment_type || 'CASH').trim().toUpperCase(),
        payment.date,
        parseFloat(payment.amount) || 0,
        String(payment.narration || payment.bank_details || 'LINKED FROM PLOT PAYMENT').trim().toUpperCase(),
        payment.id,
        payment.cheque_no || null,
        payment.cheque_status || null,
        payment.status || 'approved',
        payment.approved_by || null,
        payment.approved_at || null,
        createdBy,
      ]
    );
  }

  return { registry, created: true };
}
