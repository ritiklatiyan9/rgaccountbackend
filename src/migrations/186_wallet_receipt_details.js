import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Receipt context is stored separately so existing immutable financial entries,
// balances and the wallet cutover remain unchanged.
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('186_wallet_receipt_details'))");
    await db.query(`
      CREATE TABLE IF NOT EXISTS wallet_entry_details (
        wallet_entry_id BIGINT PRIMARY KEY REFERENCES wallet_entries(id) ON DELETE RESTRICT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE OR REPLACE FUNCTION wallet_context_row(p_table TEXT,p_id INTEGER)
      RETURNS JSONB LANGUAGE plpgsql AS $$
      DECLARE result JSONB;
      BEGIN
        IF p_id IS NULL OR p_table IS NULL OR NOT p_table=ANY(ARRAY[
          'cash_flow_entries','day_book','expenses','firm_transactions','plot_payments',
          'plot_installment_payments','land_deal_payments','misc_income_entries','farmer_payments',
          'plot_commission_payments','vendor_payments','vendor_inventory_payments','partner_profit_payments',
          'plots','farmers','firms','land_deals','plot_commissions_v2','vendor_commitments',
          'vendor_inventory_orders','cash_flow_months','sites','members','users'
        ]) OR to_regclass(p_table) IS NULL THEN RETURN NULL; END IF;
        EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE id=$1',p_table) INTO result USING p_id;
        RETURN result;
      END $$;
      CREATE OR REPLACE FUNCTION wallet_receipt_context(p_table TEXT,p_id INTEGER,p_user INTEGER)
      RETURNS JSONB LANGUAGE plpgsql AS $$
      DECLARE source JSONB; parent JSONB; plot JSONB; site JSONB; person JSONB; collector JSONB;
        site_id INTEGER; member_id INTEGER; plot_id INTEGER; parent_id INTEGER;
      BEGIN
        source:=wallet_context_row(p_table,p_id);
        collector:=wallet_context_row('users',p_user);
        IF source IS NULL THEN RETURN jsonb_strip_nulls(jsonb_build_object(
          'collector_name',collector->>'name','collector_role',collector->>'role','source_available',false)); END IF;
        plot_id:=NULLIF(source->>'plot_id','')::INTEGER;
        CASE p_table
          WHEN 'farmer_payments' THEN parent_id:=(source->>'farmer_id')::INTEGER; parent:=wallet_context_row('farmers',parent_id);
          WHEN 'firm_transactions' THEN parent_id:=(source->>'firm_id')::INTEGER; parent:=wallet_context_row('firms',parent_id);
          WHEN 'land_deal_payments' THEN parent_id:=(source->>'land_deal_id')::INTEGER; parent:=wallet_context_row('land_deals',parent_id);
          WHEN 'vendor_payments' THEN parent_id:=(source->>'commitment_id')::INTEGER; parent:=wallet_context_row('vendor_commitments',parent_id);
          WHEN 'vendor_inventory_payments' THEN parent_id:=(source->>'order_id')::INTEGER; parent:=wallet_context_row('vendor_inventory_orders',parent_id);
          WHEN 'cash_flow_entries' THEN parent_id:=(source->>'cash_flow_month_id')::INTEGER; parent:=wallet_context_row('cash_flow_months',parent_id);
          WHEN 'plot_commission_payments' THEN
            parent_id:=(source->>'plot_commission_id')::INTEGER; parent:=wallet_context_row('plot_commissions_v2',parent_id);
            plot_id:=COALESCE(plot_id,(parent->>'plot_id')::INTEGER);
          ELSE NULL;
        END CASE;
        plot:=wallet_context_row('plots',plot_id);
        site_id:=COALESCE((source->>'site_id')::INTEGER,(parent->>'site_id')::INTEGER,(plot->>'site_id')::INTEGER);
        site:=wallet_context_row('sites',site_id);
        member_id:=COALESCE((source->>'member_id')::INTEGER,(source->>'mapped_member_id')::INTEGER,
          (plot->>'buyer_member_id')::INTEGER,(parent->>'member_id')::INTEGER,(parent->>'vendor_member_id')::INTEGER,
          (parent->>'linked_member_id')::INTEGER);
        person:=wallet_context_row('members',member_id);
        RETURN jsonb_strip_nulls(jsonb_build_object(
          'site_id',site_id,'site_name',site->>'name','plot_id',plot_id,'plot_no',COALESCE(plot->>'plot_no',source->>'plot_no'),
          'member_id',member_id,'party_name',COALESCE(NULLIF(person->>'full_name',''),NULLIF(plot->>'buyer_name',''),
            NULLIF(parent->>'buyer_name',''),NULLIF(parent->>'vendor_name',''),NULLIF(parent->>'name',''),
            NULLIF(source->>'party_name',''),NULLIF(source->>'from_entity',''),NULLIF(source->>'name',''),
            NULLIF(source->>'to_entity',''),NULLIF(parent->>'ledger_name','')),
          'parent_id',parent_id,'ledger_name',CASE WHEN p_table='cash_flow_entries' THEN parent->>'ledger_name' END,
          'receipt_date',COALESCE(source->>'payment_date',source->>'date'),
          'source_created_at',source->>'created_at','payment_mode',COALESCE(source->>'payment_mode',source->>'payment_type',source->>'cash_type','CASH'),
          'source_status',source->>'status','notes',COALESCE(NULLIF(source->>'remarks',''),NULLIF(source->>'remark',''),NULLIF(source->>'notes',''),NULLIF(source->>'note','')),
          'reference',COALESCE(NULLIF(source->>'receipt_no',''),NULLIF(source->>'reference_no',''),NULLIF(parent->>'deal_no','')),
          'collector_name',collector->>'name','collector_role',collector->>'role','source_available',true));
      END $$;
      CREATE OR REPLACE FUNCTION snapshot_wallet_entry_details() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE context JSONB; previous JSONB;
      BEGIN
        context:=wallet_receipt_context(NEW.source_table,NEW.source_id,NEW.user_id);
        IF NOT COALESCE((context->>'source_available')::BOOLEAN,false) AND NEW.source_table IS NOT NULL THEN
          SELECT d.details INTO previous FROM wallet_entry_details d JOIN wallet_entries e ON e.id=d.wallet_entry_id
            WHERE e.source_table=NEW.source_table AND e.source_id=NEW.source_id AND e.id<NEW.id ORDER BY e.id DESC LIMIT 1;
          context:=COALESCE(previous,'{}'::jsonb)||context;
        END IF;
        INSERT INTO wallet_entry_details(wallet_entry_id,details) VALUES(NEW.id,context);
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS wallet_receipt_context_snapshot ON wallet_entries;
      CREATE TRIGGER wallet_receipt_context_snapshot AFTER INSERT ON wallet_entries
        FOR EACH ROW EXECUTE FUNCTION snapshot_wallet_entry_details();
      INSERT INTO wallet_entry_details(wallet_entry_id,details)
        SELECT id,wallet_receipt_context(source_table,source_id,user_id) FROM wallet_entries
        ON CONFLICT DO NOTHING;
      DROP TRIGGER IF EXISTS wallet_context_immutable ON wallet_entry_details;
      CREATE TRIGGER wallet_context_immutable BEFORE UPDATE OR DELETE ON wallet_entry_details
        FOR EACH ROW EXECUTE FUNCTION guard_wallet_entry_history();
      INSERT INTO app_schema_migrations(version) VALUES('186_wallet_receipt_details') ON CONFLICT DO NOTHING;
    `);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Wallet receipt details ready'))
    .catch(error => { console.error(error.message); process.exitCode=1; })
    .finally(() => pool.end());
}
