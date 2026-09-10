const invalid = message => Object.assign(new Error(message), { statusCode: 400, code: 'INVALID_PAYMENT_BANK' });

// Edit requests carry the selected bank as proposed data. Apply it only when
// approved, on the same transaction connection as the payment edit.
export async function applyFarmerPaymentBank(db, payment, proposed) {
  if (proposed.bank_account_id === undefined) return;
  const bankId = String(payment.payment_mode).toUpperCase() === 'CASH' ? null : Number(proposed.bank_account_id);
  if (bankId !== null && (!Number.isSafeInteger(bankId) || bankId <= 0)) {
    throw invalid('Select a bank account for this payment mode.');
  }
  if (bankId !== null) {
    const bank = await db.query(`SELECT ba.id FROM bank_accounts ba
      JOIN farmers f ON f.site_id = ba.site_id
      WHERE f.id = $1 AND ba.id = $2 AND ba.is_active = true`, [payment.farmer_id, bankId]);
    if (!bank.rows.length) throw invalid('Choose an active bank account from the same site as this payment.');
  }
  const result = await db.query(`UPDATE cash_flow_entries cfe
    SET bank_account_id = $1, updated_at = NOW()
    FROM farmers f WHERE f.id = $2 AND cfe.site_id = f.site_id
      AND cfe.source_module = 'farmer_payments' AND cfe.source_id = $3
    RETURNING cfe.id`, [bankId, payment.farmer_id, payment.id]);
  if (!result.rows.length) throw invalid('Ledger row not found for this payment.');
}
