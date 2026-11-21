export const drawPaymentEditSql = `
CREATE OR REPLACE FUNCTION update_draw_payment_with_accounting(
 p_registration_id integer, p_payment_id integer, p_actor_id integer, p_changes jsonb
) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
 registration record;
 payment record;
 revised record;
 receipt pool_money_receipts%ROWTYPE;
 ledger cash_flow_entries%ROWTYPE;
 has_transfer boolean:=false;
 has_tds boolean:=false;
 edit_setting text;
BEGIN
 SELECT site_id,status INTO registration FROM draw_registrations WHERE id=p_registration_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO payment FROM draw_payments WHERE id=p_payment_id AND draw_registration_id=p_registration_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF payment.plot_payment_id IS NOT NULL OR registration.status IN ('CANCELLED','ALLOTTED') THEN
   RAISE EXCEPTION 'This draw ledger is closed. Review the receipt in Accounting.'
     USING ERRCODE='23514',CONSTRAINT='draw_payment_edit_conflict';
 END IF;
 SELECT * INTO revised FROM jsonb_populate_record(NULL::draw_payments,to_jsonb(payment)||p_changes);

 SELECT * INTO receipt FROM pool_money_receipts WHERE source_kind='draw' AND source_id=p_payment_id FOR UPDATE;
 IF FOUND THEN
   SELECT * INTO ledger FROM cash_flow_entries WHERE source_module='pool_money_receipts' AND source_id=receipt.id FOR UPDATE;
   IF NOT FOUND OR receipt.owner_id IS DISTINCT FROM p_registration_id
     OR receipt.site_id IS DISTINCT FROM registration.site_id OR ledger.site_id IS DISTINCT FROM registration.site_id
     OR receipt.amount IS DISTINCT FROM payment.amount OR ledger.credit IS DISTINCT FROM payment.amount
     OR ledger.debit IS DISTINCT FROM 0::numeric THEN
     RAISE EXCEPTION 'The Accounting entry is missing or differs from this receipt. Review it in Accounting.'
       USING ERRCODE='23514',CONSTRAINT='draw_payment_edit_conflict';
   END IF;
   IF receipt.plot_payment_id IS NOT NULL
     OR receipt.status IS DISTINCT FROM 'pending' OR ledger.status IS DISTINCT FROM 'pending'
     OR receipt.approved_at IS NOT NULL OR ledger.approved_at IS NOT NULL
     OR receipt.approved_by IS NOT NULL OR ledger.approved_by IS NOT NULL
     OR COALESCE(receipt.cheque_status,'PENDING') <> 'PENDING'
     OR COALESCE(ledger.cheque_status,'PENDING') <> 'PENDING' THEN
     RAISE EXCEPTION 'This receipt has already been processed in Accounting. Correct it there.'
       USING ERRCODE='23514',CONSTRAINT='draw_payment_edit_conflict';
   END IF;
   PERFORM 1 FROM cash_flow_months WHERE id=ledger.cash_flow_month_id AND is_locked IS FALSE FOR SHARE;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'This receipt belongs to a locked or missing accounting period.'
       USING ERRCODE='23514',CONSTRAINT='draw_payment_edit_conflict';
   END IF;
   IF to_regclass('cashflow_transfer_allocations') IS NOT NULL THEN
     SELECT EXISTS(SELECT 1 FROM cashflow_transfer_allocations WHERE source_entry_id=ledger.id) INTO has_transfer;
   END IF;
   IF to_regclass('tds_settlements') IS NOT NULL THEN
     SELECT EXISTS(SELECT 1 FROM tds_settlements WHERE existing_entry_id=ledger.id) INTO has_tds;
   END IF;
   IF has_transfer OR has_tds OR EXISTS(SELECT 1 FROM day_book WHERE cash_flow_entry_id=ledger.id)
     OR EXISTS(SELECT 1 FROM firm_transactions WHERE cash_flow_entry_id=ledger.id) THEN
     RAISE EXCEPTION 'This receipt backs a posted entry. Reverse that entry in Accounting before editing the receipt.'
       USING ERRCODE='23514',CONSTRAINT='draw_payment_edit_conflict';
   END IF;

   -- Keep both projection IDs and the collector. Reuse the existing period and wallet triggers.
   edit_setting:=current_setting('app.draw_pending_receipt_edit_id',true);
   PERFORM set_config('app.draw_pending_receipt_edit_id',receipt.id::text,true);
   UPDATE pool_money_receipts SET
     amount=revised.amount,date=revised.payment_date,payment_from=revised.payment_from,
     payment_type=CASE revised.payment_from WHEN 'CASH' THEN 'CASH' WHEN 'CHEQUE' THEN 'CHEQUE' ELSE 'BANK' END,
     bank_name=revised.bank_name,branch=revised.branch,bank_details=revised.bank_details,bank_account_id=revised.bank_account_id,
     cheque_no=revised.cheque_no,cheque_status=CASE WHEN revised.payment_from='CHEQUE' THEN 'PENDING' END,
     received_by=revised.received_by,narration=revised.narration,updated_at=now()
   WHERE id=receipt.id;
   PERFORM set_config('app.draw_pending_receipt_edit_id',COALESCE(edit_setting,''),true);
   INSERT INTO pool_money_events(source_kind,owner_id,site_id,event_type,detail,actor_user_id)
   VALUES('draw',p_registration_id,registration.site_id,'RECEIPT_UPDATED',
     jsonb_build_object('payment_id',payment.id,'receipt_id',receipt.id,'cash_flow_entry_id',ledger.id,
       'amount_before',payment.amount,'amount_after',revised.amount),p_actor_id);
 ELSE
   -- Editing a historical receipt must preserve its unrecorded state.
   edit_setting:=current_setting('app.draw_unrecorded_receipt_edit_id',true);
   PERFORM set_config('app.draw_unrecorded_receipt_edit_id',payment.id::text,true);
 END IF;

 UPDATE draw_payments SET amount=revised.amount,payment_date=revised.payment_date,payment_from=revised.payment_from,
   bank_name=revised.bank_name,branch=revised.branch,bank_details=revised.bank_details,bank_account_id=revised.bank_account_id,
   cheque_no=revised.cheque_no,received_by=revised.received_by,narration=revised.narration
 WHERE id=payment.id;
 IF receipt.id IS NULL THEN
   PERFORM set_config('app.draw_unrecorded_receipt_edit_id',COALESCE(edit_setting,''),true);
 END IF;
 RETURN true;
END $$;
`;
