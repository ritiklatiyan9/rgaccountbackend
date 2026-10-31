import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '232_wallet_imprest_transfers';
export const walletImprestTransfersSql = `
CREATE TABLE IF NOT EXISTS wallet_imprest_transfers (
  id UUID PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount NUMERIC(15,2) NOT NULL CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=1000),
  idempotency_key UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled')),
  sender_accepted_at TIMESTAMPTZ,
  recipient_accepted_at TIMESTAMPTZ,
  sender_acceptance_note TEXT NOT NULL DEFAULT '' CHECK(length(sender_acceptance_note)<=1000),
  recipient_acceptance_note TEXT NOT NULL DEFAULT '' CHECK(length(recipient_acceptance_note)<=1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id),
  resolution_note TEXT NOT NULL DEFAULT '',
  CONSTRAINT wallet_imprest_different_users CHECK(from_user_id<>to_user_id),
  CONSTRAINT wallet_imprest_complete_acceptance CHECK(status<>'accepted' OR (sender_accepted_at IS NOT NULL AND recipient_accepted_at IS NOT NULL)),
  CONSTRAINT wallet_imprest_request_key UNIQUE(requested_by,idempotency_key)
);
ALTER TABLE wallet_imprest_transfers ADD COLUMN IF NOT EXISTS sender_acceptance_note TEXT NOT NULL DEFAULT '' CHECK(length(sender_acceptance_note)<=1000);
ALTER TABLE wallet_imprest_transfers ADD COLUMN IF NOT EXISTS recipient_acceptance_note TEXT NOT NULL DEFAULT '' CHECK(length(recipient_acceptance_note)<=1000);
CREATE INDEX IF NOT EXISTS wallet_imprest_site_history ON wallet_imprest_transfers(organization_id,site_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS wallet_imprest_sender_pending ON wallet_imprest_transfers(organization_id,site_id,from_user_id,created_at DESC) WHERE status='pending';
CREATE INDEX IF NOT EXISTS wallet_imprest_recipient_pending ON wallet_imprest_transfers(organization_id,site_id,to_user_id,created_at DESC) WHERE status='pending';
CREATE INDEX IF NOT EXISTS wallet_imprest_requester_history ON wallet_imprest_transfers(requested_by,site_id,created_at DESC);
ALTER TABLE loyalty_vault_entries DROP CONSTRAINT IF EXISTS loyalty_vault_entries_kind_check;
ALTER TABLE loyalty_vault_entries ADD CONSTRAINT loyalty_vault_entries_kind_check
  CHECK(kind IN ('credit','debit','adjustment','reversal','transfer_in','transfer_out','imprest_out'));
ALTER TABLE loyalty_vault_entries ADD COLUMN IF NOT EXISTS wallet_imprest_transfer_id UUID REFERENCES wallet_imprest_transfers(id);
ALTER TABLE imprest_ledger ADD COLUMN IF NOT EXISTS wallet_imprest_transfer_id UUID REFERENCES wallet_imprest_transfers(id);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_imprest_one_wallet_posting ON loyalty_vault_entries(wallet_imprest_transfer_id) WHERE wallet_imprest_transfer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_imprest_one_float_posting ON imprest_ledger(wallet_imprest_transfer_id) WHERE wallet_imprest_transfer_id IS NOT NULL;
CREATE OR REPLACE FUNCTION link_wallet_imprest_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='imprest_out' THEN
    NEW.wallet_imprest_transfer_id:=NULLIF(NEW.details->>'wallet_imprest_transfer_id','')::uuid;
    IF NEW.wallet_imprest_transfer_id IS NULL THEN RAISE EXCEPTION 'Wallet imprest posting requires its transfer'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wallet_imprest_posting_link ON loyalty_vault_entries;
CREATE TRIGGER wallet_imprest_posting_link BEFORE INSERT ON loyalty_vault_entries
  FOR EACH ROW EXECUTE FUNCTION link_wallet_imprest_posting();
CREATE TABLE IF NOT EXISTS wallet_imprest_notification_outbox (
  id UUID PRIMARY KEY,transfer_id UUID NOT NULL REFERENCES wallet_imprest_transfers(id),event_key TEXT UNIQUE NOT NULL,
  payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),delivered_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_error TEXT
);
CREATE INDEX IF NOT EXISTS wallet_imprest_outbox_pending ON wallet_imprest_notification_outbox(next_attempt_at,created_at) WHERE delivered_at IS NULL;
`;

export async function up(database=pool) {
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('232_wallet_imprest_transfers'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await db.query(walletImprestTransfersSql);
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[VERSION]);
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(()=>console.log('Migration 232: wallet imprest acceptance ready'))
    .catch(error=>{console.error('Migration 232 failed:',error.message);process.exitCode=1;}).finally(()=>pool.end());
}
