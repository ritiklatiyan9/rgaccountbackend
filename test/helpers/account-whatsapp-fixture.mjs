import { PGlite } from "@electric-sql/pglite";

// Same minimal accountancy schema the Studio tests run on, shared by the Hindi tests.
export const baseline = `
CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);
CREATE TABLE users(id integer PRIMARY KEY);
INSERT INTO sites VALUES(1,'Defence Garden',1),(2,'Second Site',1),(3,'Other Company',2);
INSERT INTO users VALUES(1);
CREATE TABLE application_settings(id serial PRIMARY KEY,site_id integer,setting_key text,setting_value jsonb,updated_at timestamptz DEFAULT now());
CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS $$SELECT$$;
CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$SELECT $2='approved' AND ($3<>'CHEQUE' OR $4='CLEARED')$$;
CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text,whatsapp text,member_type text,member_types text[],member_code text,status text DEFAULT 'ACTIVE');
INSERT INTO members VALUES(10,1,'Rahul Sharma','9876543210',NULL,'CLIENT',ARRAY['CLIENT'],'CLT-10','ACTIVE'),(11,2,'Wrong Site','9876543211',NULL,'CLIENT',ARRAY['CLIENT'],'CLT-11','ACTIVE');
CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,buyer_name text,buyer_member_id integer,status text,approval_status text,installments_enabled boolean);
INSERT INTO plots VALUES(20,1,'A12','Rahul Sharma',10,'BOOKED','approved',true);
CREATE TABLE bookings(id integer PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,status text);
CREATE TABLE kyc_cases(id integer PRIMARY KEY,client_member_id integer,site_id integer,status text,booking_id integer);
INSERT INTO kyc_cases VALUES(30,10,1,'VERIFIED',NULL);
CREATE TABLE plot_payments(id integer PRIMARY KEY,plot_id integer,site_id integer,amount numeric,payment_type text,payment_from text,date date,status text,cheque_status text,money_transfer_id text,money_transfer_role text,entry_transfer_id text);
INSERT INTO plot_payments VALUES(40,20,1,1000,'BANK','UPI',CURRENT_DATE,'approved',NULL,NULL,NULL,NULL);
CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer,installment_name text,amount numeric,due_date date,sort_order integer);
INSERT INTO plot_installments VALUES(50,20,'Installment 1',5000,(now() AT TIME ZONE 'Asia/Kolkata')::date+3,0);
CREATE TABLE plot_installment_payments(id integer PRIMARY KEY,plot_id integer,installment_id integer,amount numeric,payment_mode text,payment_date date,status text,cheque_status text);
INSERT INTO plot_installment_payments VALUES(60,20,50,500,'BANK',CURRENT_DATE,'approved',NULL);
CREATE TABLE plot_registries(id integer PRIMARY KEY,site_id integer,plot_id integer,registry_date date,plot_no text);
INSERT INTO plot_registries VALUES(70,1,20,CURRENT_DATE,'A12');
CREATE TABLE registry_document_handovers(id integer PRIMARY KEY,registry_id integer);
CREATE TABLE documents(id integer PRIMARY KEY,plot_id integer,kyc_case_id integer,uploaded_source text,file_path text,category text);
`;
export async function fixture(t) {
  const pg = new PGlite();
  await pg.exec(baseline);
  const db = {
    query: (sql, args = []) =>
      args.length
        ? pg.query(sql, args)
        : pg.exec(sql).then((results) => results.at(-1)),
    connect: async () => ({ query: db.query, release() {} }),
  };
  t.after(() => pg.close());
  return { pg, db };
}
/** A provider that approves every submission immediately, remembering what it was sent. */
export const approvingTransport = (status = "APPROVED") => {
  const created = [];
  return {
    created,
    uploadTemplateMedia: async () => "sample-header-handle",
    create: async (definition) => {
      created.push(definition);
      return {
        templateStatus: status,
        metaTemplateId: "meta-" + Math.random(),
        category: "UTILITY",
      };
    },
    rejection: async () => null,
    remove: async () => {},
    list: async () => [],
  };
};
