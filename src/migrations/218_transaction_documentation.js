import { pathToFileURL } from 'node:url';
export const documentationSchemaSql = `
CREATE TABLE IF NOT EXISTS transaction_documentation (
  source text NOT NULL, record_id bigint NOT NULL, site_id integer NOT NULL REFERENCES sites(id),
  bill_required boolean, voucher_required boolean, reason text NOT NULL DEFAULT '',
  documents jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(documents)='array'),
  version integer NOT NULL DEFAULT 1, updated_by integer, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source,record_id)
);
CREATE INDEX IF NOT EXISTS transaction_documentation_site ON transaction_documentation(site_id,source);
CREATE TABLE IF NOT EXISTS transaction_documentation_policies (
  site_id integer NOT NULL REFERENCES sites(id), source text NOT NULL, transaction_type text NOT NULL DEFAULT '*',
  bill_required boolean NOT NULL, voucher_required boolean NOT NULL,
  bill_locked boolean NOT NULL DEFAULT false, voucher_locked boolean NOT NULL DEFAULT false,
  reason text NOT NULL DEFAULT '',version integer NOT NULL DEFAULT 1,updated_by integer,updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(site_id,source,transaction_type)
);
CREATE TABLE IF NOT EXISTS transaction_documentation_history (
  id bigserial PRIMARY KEY,site_id integer NOT NULL,source text NOT NULL,record_id bigint,
  transaction_type text,actor_id integer,actor_name text,created_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT '',changes jsonb NOT NULL,event_type text NOT NULL DEFAULT 'requirements'
);
CREATE INDEX IF NOT EXISTS transaction_documentation_history_record ON transaction_documentation_history(source,record_id,id DESC);

CREATE OR REPLACE FUNCTION transaction_documentation_urls(p_record jsonb,p_kind text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_agg(DISTINCT to_jsonb(url)), '[]'::jsonb) FROM (
    SELECT btrim(value) AS url FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(p_record->(p_kind||'_urls'))='array' THEN p_record->(p_kind||'_urls') ELSE '[]'::jsonb END
      || CASE WHEN NULLIF(btrim(p_record->>(p_kind||'_url')),'') IS NOT NULL
              THEN jsonb_build_array(p_record->>(p_kind||'_url')) ELSE '[]'::jsonb END
    ) AS value
  ) files WHERE url ~ '^(https?://[^[:space:]]+|/uploads/[^[:space:]]+)$'
$$;

CREATE OR REPLACE FUNCTION transaction_documentation_type(p_record jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(COALESCE(NULLIF(p_record->>'documentation_type',''),NULLIF(p_record->>'transaction_type',''),
    NULLIF(p_record->>'entry_type',''),CASE WHEN p_record->>'is_firm_to_firm_transfer'='true' THEN 'internal_transfer' END,
    CASE WHEN COALESCE(NULLIF(p_record->>'credit',''),'0')::numeric > 0 THEN 'credit' ELSE 'debit' END))
$$;
CREATE OR REPLACE FUNCTION transaction_documentation_mode(p_record jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(COALESCE(NULLIF(p_record->>'payment_mode',''),NULLIF(p_record->>'cash_type',''),NULLIF(p_record->>'payment_type',''),'CASH'))
$$;

CREATE OR REPLACE FUNCTION transaction_documentation_state(p_source text,p_id bigint,p_site integer,p_record jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH context AS (
  SELECT transaction_documentation_type(p_record) AS kind,transaction_documentation_mode(p_record) AS mode
), policies AS (
  SELECT p.* FROM transaction_documentation_policies p,context c
  WHERE p.site_id=p_site AND p.source=p_source AND p.transaction_type IN ('*',c.kind)
), policy AS (
  SELECT p.* FROM policies p,context c ORDER BY (p.transaction_type=c.kind) DESC LIMIT 1
), mandatory AS (
  SELECT COALESCE(bool_or(bill_locked),false) AS bill_locked,COALESCE(bool_or(voucher_locked),false) AS voucher_locked FROM policies
), resolved AS (
  SELECT d.version,d.reason,d.updated_by,d.updated_at,d.documents,
    m.bill_locked,m.voucher_locked,
    CASE WHEN m.bill_locked THEN true ELSE COALESCE(d.bill_required,p.bill_required,p_source='expense' AND c.mode<>'CASH') END AS bill_required,
    CASE WHEN m.voucher_locked THEN true ELSE COALESCE(d.voucher_required,p.voucher_required,
      (p_record->>'voucher_gap_filled_at') IS NULL AND c.mode='CASH') END AS voucher_required,
    p.version AS policy_version,c.kind, d.bill_required IS NOT NULL AS bill_override,d.voucher_required IS NOT NULL AS voucher_override
  FROM context c CROSS JOIN mandatory m LEFT JOIN policy p ON true
  LEFT JOIN transaction_documentation d ON d.source=p_source AND d.record_id=p_id AND d.site_id=p_site
), files AS (
 SELECT r.*,
   transaction_documentation_urls(p_record,'bill') || COALESCE((SELECT jsonb_agg(doc->'url') FROM jsonb_array_elements(COALESCE(r.documents,'[]')) doc WHERE doc->>'kind'='bill'),'[]') AS bill_urls,
   transaction_documentation_urls(p_record,'voucher') || COALESCE((SELECT jsonb_agg(doc->'url') FROM jsonb_array_elements(COALESCE(r.documents,'[]')) doc WHERE doc->>'kind'='voucher'),'[]') AS voucher_urls
 FROM resolved r
), gaps AS (
 SELECT f.*,bill_required AND jsonb_array_length(bill_urls)=0 AS missing_bill,
   voucher_required AND jsonb_array_length(voucher_urls)=0 AS missing_voucher FROM files f
)
SELECT jsonb_build_object('source',p_source,'record_id',p_id,'site_id',p_site,
 'version',COALESCE(version,0),'reason',COALESCE(reason,''),'updated_by',updated_by,'updated_at',updated_at,
 'policy_version',policy_version,'transaction_type',kind,'bill_required',bill_required,'voucher_required',voucher_required,
 'bill_override',bill_override,'voucher_override',voucher_override,'locked',jsonb_build_object('bill',bill_locked,'voucher',voucher_locked),
 'bill_urls',bill_urls,'voucher_urls',voucher_urls,'sidecar_documents',COALESCE(documents,'[]'),
 'legacy_bill_urls',transaction_documentation_urls(p_record,'bill'),'legacy_voucher_urls',transaction_documentation_urls(p_record,'voucher'),
 'missing_bill',missing_bill,'missing_voucher',missing_voucher,
 'status',CASE WHEN missing_bill AND missing_voucher THEN 'missing_both' WHEN missing_bill THEN 'missing_bill'
   WHEN missing_voucher THEN 'missing_voucher' WHEN NOT bill_required AND NOT voucher_required THEN 'not_required' ELSE 'complete' END)
FROM gaps
$$;
`;

// Sidecar tables only: no transaction UPDATE, posting trigger or attachment rewrite.
export async function up(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(documentationSchemaSql);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    default: pool
  } = await import('../config/db.js');
  try {
    await up(pool);
    console.log('Transaction documentation schema ready.');
  } finally {
    await pool.end();
  }
}
