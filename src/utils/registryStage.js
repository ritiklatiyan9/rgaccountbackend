// Registry lifecycle stage — the single source of truth behind the red / yellow /
// green rows in Plot Registry and the stepper in the NOC workspace.
//
//   red    → the entry exists (usually auto-created when the NOC was generated) but the
//            legal details are still incomplete
//   yellow → every detail is filled, the registry deed is not uploaded yet
//   blue   → the registry deed is uploaded, not yet handed over to the client
//   green  → the deed has been handed over (photo + client signature on record)
const n = (v) => Number(v) || 0;

export const REGISTRY_STAGE_LABEL = Object.freeze({
  red: 'Details pending',
  yellow: 'Deed pending',
  blue: 'Handover pending',
  green: 'Handed over',
});

/** Adds stage fields to a plot_registries row that carries registry_doc_count. */
export function decorateRegistryStage(row) {
  if (!row) return row;
  const missing = [];
  if (!String(row.customer_name || '').trim()) missing.push('Customer name');
  if (!row.registry_date) missing.push('Registry date');
  if (!(n(row.size_meter) > 0 || n(row.size_sqyard) > 0)) missing.push('Plot size');
  if (!(n(row.circle_rate) > 0)) missing.push('Circle rate');
  if (!String(row.farmer_name || row.seller_name || '').trim()) missing.push('Farmer / seller name');
  if (!(n(row.registry_payment) > 0)) missing.push('Registry amount');
  // Registry Value RO — the rounded amount actually received (cash + bank), kept beside the
  // exact figures. ro_diff is the round-off: RO total minus what the payments record says.
  const roCash = row.ro_cash_amount === null || row.ro_cash_amount === undefined ? null : n(row.ro_cash_amount);
  const roBank = row.ro_bank_amount === null || row.ro_bank_amount === undefined ? null : n(row.ro_bank_amount);
  const roSet = roCash !== null || roBank !== null;
  const roTotal = roSet ? Math.round(((roCash || 0) + (roBank || 0)) * 100) / 100 : null;
  const deed = n(row.registry_doc_count) > 0;
  const handedOver = n(row.handover_count) > 0;
  const stage = handedOver ? 'green' : deed ? 'blue' : missing.length === 0 ? 'yellow' : 'red';
  return {
    ...row,
    ro_set: roSet,
    ro_total: roTotal,
    ro_diff: roSet ? Math.round((roTotal - n(row.total_paid)) * 100) / 100 : null,
    noc_generated: Boolean(row.noc_generated_at),
    deed_uploaded: deed,
    handed_over: handedOver,
    details_complete: missing.length === 0,
    missing_details: missing,
    stage,
    stage_label: REGISTRY_STAGE_LABEL[stage],
  };
}
