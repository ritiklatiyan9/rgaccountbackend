import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { up as baseUp } from "../src/migrations/225_account_whatsapp_studio.js";
import { up as documentUp } from "../src/migrations/226_account_whatsapp_documents.js";
const up = async (db) => {
  const base = await baseUp(db);
  const documents = await documentUp(db);
  return base || documents;
};
import {
  createRequestTransaction,
  installRequestTransactionAdapter,
  requestTransactionContext,
} from "../src/services/requestTransactionContext.js";
import {
  ACCOUNT_WHATSAPP_EVENTS,
  accountWhatsAppStudio,
  createAccountWhatsAppTemplate,
  saveAccountWhatsAppStage,
  updateAccountWhatsAppTemplate,
  deleteAccountWhatsAppTemplate,
  previewAccountWhatsAppTemplate,
  testAccountWhatsAppTemplate,
  refreshAccountWhatsAppTemplates,
  queueAccountWhatsApp,
  drainAccountWhatsApp,
  loadAccountWhatsAppContext,
  scheduleAccountWhatsAppReminders,
  startAccountWhatsAppWorker,
  stopAccountWhatsAppWorker,
  listAccountWhatsAppRemoteTemplates,
  getAccountWhatsAppRemoteTemplate,
  importAccountWhatsAppTemplate,
  previewAccountWhatsAppReceipt,
} from "../src/services/accountWhatsApp.service.js";
import {
  RECEIPT_DESIGN_KEY,
  RECEIPT_SITE_DESIGN_KEY,
} from "../src/services/receiptDesign.service.js";
import {
  compileAccountWhatsAppBody,
  isAccountWhatsAppPaymentEligible,
  accountWhatsAppCategory,
} from "../src/services/accountWhatsApp.spec.js";
import {
  inspectAccountWhatsAppRemoteTemplate,
  mapAccountWhatsAppRemoteBody,
  accountWhatsAppProviderName,
  accountTemplateStatesPendingKyc,
} from "../src/services/accountWhatsAppImport.spec.js";

const admin = { id: 1, role: "admin", organization_id: 1 };
const approvedAwsRegistration = () => ({
  id: "1139360278456197",
  name: "dgg_registered_v2",
  status: "APPROVED",
  category: "UTILITY",
  language: "en",
  components: [
    {
      type: "BODY",
      text: "Dear *{{1}}*, your customer record has been created at *{{2}}*.\n\n*Member ID:* {{3}}\n*KYC Status:* Pending\n\nPlease quote this Member ID. Thank you, {{1}}.",
      example: { body_text: [["Rahul Sharma", "Defence Garden", "CLT-00123"]] },
    },
  ],
});
const importInput = () => ({
  site_id: 1,
  event: "CLIENT_ONBOARDED",
  meta_template_id: "1139360278456197",
  title: "Approved registration",
  fields: ["customer_name", "project", "member_id"],
});
function importedTransport(definition = approvedAwsRegistration()) {
  const calls = { create: 0, remove: 0, get: 0 };
  return {
    calls,
    definition,
    create: async () => {
      calls.create++;
      throw new Error("Import must never create a Meta submission");
    },
    remove: async () => {
      calls.remove++;
    },
    get: async (id) => {
      calls.get++;
      assert.equal(id, String(definition.id));
      return structuredClone(definition);
    },
    list: async () => [
      {
        templateName: definition.name,
        metaTemplateId: definition.id,
        templateStatus: definition.status,
        templateCategory: definition.category,
      },
    ],
  };
}
const baseline = `
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
async function fixture(t) {
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
const localTransport = (status = "APPROVED") => ({
  uploadTemplateMedia: async () => "sample-header-handle",
  create: async () => ({
    templateStatus: status,
    metaTemplateId: "meta-" + Math.random(),
    category: "UTILITY",
  }),
  rejection: async () => null,
  remove: async () => {},
  list: async () => [],
});
async function apply(db, event, siteId = 1) {
  const template = await createAccountWhatsAppTemplate(
    admin,
    {
      site_id: siteId,
      event,
      title: event,
      body: ACCOUNT_WHATSAPP_EVENTS[event].body,
    },
    { db, transport: localTransport() },
  );
  await saveAccountWhatsAppStage(
    admin,
    event,
    { site_id: siteId, template_name: template.name, enabled: true },
    { db },
  );
  return template;
}

test("every default template meets Meta body constraints and uses event-scoped sample fields", () => {
  for (const [event, spec] of Object.entries(ACCOUNT_WHATSAPP_EVENTS)) {
    const compiled = compileAccountWhatsAppBody(event, spec.body);
    assert.ok(compiled.text.length <= 1024);
    assert.ok(!compiled.preview.includes("{"));
  }
  for (const body of [
    "Hello\n\n\nclient.",
    "{customer_name}",
    "Hello {amount} client.",
    "Hi {{1}} there.",
    "Hi {customer_name} {project} there.",
  ])
    assert.throws(() => compileAccountWhatsAppBody("CLIENT_ONBOARDED", body));
  assert.throws(() =>
    compileAccountWhatsAppBody(
      "CLIENT_ONBOARDED",
      "Hello 😀😀😀😀😀😀😀😀😀😀😀 there.",
    ),
  );
});

test("only supported explicit template categories are accepted", () => {
  assert.equal(accountWhatsAppCategory(), "UTILITY");
  assert.equal(accountWhatsAppCategory(" marketing "), "MARKETING");
  for (const value of ["", "AUTHENTICATION", "SYSTEM", null, true, []])
    assert.throws(() => accountWhatsAppCategory(value), /Utility or Marketing/);
  assert.doesNotMatch(
    ACCOUNT_WHATSAPP_EVENTS.CLIENT_ONBOARDED.body,
    /welcome/i,
  );
});

test("approved AWS parsing preserves positional order and repeated variables; media and missing indices are blocked", () => {
  const remote = inspectAccountWhatsAppRemoteTemplate(
    approvedAwsRegistration(),
  );
  assert.equal(remote.parameters.length, 3);
  const body = mapAccountWhatsAppRemoteBody(
    remote,
    "CLIENT_ONBOARDED",
    importInput().fields,
  );
  assert.match(body, /created at \*\{project\}\*/);
  assert.equal((body.match(/\{customer_name\}/g) || []).length, 2);
  assert.equal(accountTemplateStatesPendingKyc(body), true);
  for (const fields of [
    [],
    ["customer_name", "member_id"],
    ["customer_name", "project", "amount"],
  ])
    assert.throws(
      () => mapAccountWhatsAppRemoteBody(remote, "CLIENT_ONBOARDED", fields),
      /Map every/,
    );
  const media = approvedAwsRegistration();
  media.components.unshift({ type: "HEADER", format: "DOCUMENT" });
  assert.equal(inspectAccountWhatsAppRemoteTemplate(media).has_document, true);
  assert.throws(
    () =>
      mapAccountWhatsAppRemoteBody(
        inspectAccountWhatsAppRemoteTemplate(media),
        "CLIENT_ONBOARDED",
        importInput().fields,
      ),
    /PDF receipt templates/,
  );
  const broken = approvedAwsRegistration();
  broken.components[0].text = "Hello {{2}}, thank you.";
  assert.equal(inspectAccountWhatsAppRemoteTemplate(broken).supported, false);
  assert.throws(
    () =>
      accountWhatsAppProviderName({
        name: "aws:1:CLIENT_ONBOARDED:1139360278456197:dgg_registered_v2",
        site_id: 2,
      }),
    /Invalid/,
  );
});

test("approved imports are idempotent, project-scoped references and never submit to Meta", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const transport = importedTransport();
  const first = await importAccountWhatsAppTemplate(admin, importInput(), {
    db,
    transport,
  });
  const again = await importAccountWhatsAppTemplate(admin, importInput(), {
    db,
    transport,
  });
  const second = await importAccountWhatsAppTemplate(
    admin,
    { ...importInput(), site_id: 2 },
    { db, transport },
  );
  assert.equal(first.id, again.id);
  assert.notEqual(first.name, second.name);
  assert.equal(first.provider_name, "dgg_registered_v2");
  assert.equal(first.imported, true);
  assert.equal(first.status, "APPROVED");
  assert.equal(accountWhatsAppProviderName(second), "dgg_registered_v2");
  assert.equal(transport.calls.create, 0);
  assert.equal(
    (await accountWhatsAppStudio(admin, 1, { db })).stages[0].settings.enabled,
    false,
  );
  assert.deepEqual(
    (await listAccountWhatsAppRemoteTemplates(admin, 1, { db, transport }))
      .templates[0].imported_events,
    ["CLIENT_ONBOARDED"],
  );
  await assert.rejects(
    saveAccountWhatsAppStage(
      admin,
      "CLIENT_ONBOARDED",
      { site_id: 1, template_name: second.name },
      { db },
    ),
    /approved/,
  );
  assert.equal(
    (
      await getAccountWhatsAppRemoteTemplate(
        admin,
        1,
        transport.definition.id,
        { db, transport },
      )
    ).supported,
    true,
  );
});

test("AWS imports revalidate authorization, approval, component compatibility and field mapping before writing", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const transport = importedTransport();
  for (const actor of [
    { ...admin, role: "sub_admin" },
    { ...admin, organization_id: 2 },
  ]) {
    await assert.rejects(
      importAccountWhatsAppTemplate(actor, importInput(), { db, transport }),
      (error) => error.status === 403,
    );
    await assert.rejects(
      listAccountWhatsAppRemoteTemplates(actor, 1, { db, transport }),
      (error) => error.status === 403,
    );
    await assert.rejects(
      getAccountWhatsAppRemoteTemplate(actor, 1, transport.definition.id, {
        db,
        transport,
      }),
      (error) => error.status === 403,
    );
  }
  assert.equal(transport.calls.get, 0);
  for (const status of ["REJECTED", "PENDING", "PAUSED"]) {
    transport.definition.status = status;
    await assert.rejects(
      importAccountWhatsAppTemplate(admin, importInput(), { db, transport }),
      /currently approved/,
    );
  }
  transport.definition.status = "APPROVED";
  transport.definition.components.unshift({
    type: "HEADER",
    format: "DOCUMENT",
  });
  await assert.rejects(
    importAccountWhatsAppTemplate(admin, importInput(), { db, transport }),
    /PDF receipt templates/,
  );
  transport.definition.components.shift();
  await assert.rejects(
    importAccountWhatsAppTemplate(
      admin,
      { ...importInput(), fields: ["customer_name"] },
      { db, transport },
    ),
    /Map every/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT COUNT(*)::int AS count FROM account_whatsapp_templates",
      )
    ).rows[0].count,
    0,
  );
});

test("removing imported references never deletes the shared AWS template and assigned references stay protected", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const transport = importedTransport();
  const row = await importAccountWhatsAppTemplate(admin, importInput(), {
    db,
    transport,
  });
  await saveAccountWhatsAppStage(
    admin,
    "CLIENT_ONBOARDED",
    { site_id: 1, template_name: row.name },
    { db },
  );
  await assert.rejects(
    deleteAccountWhatsAppTemplate(admin, row.name, 1, { db, transport }),
    /Unapply/,
  );
  await assert.rejects(
    importAccountWhatsAppTemplate(
      admin,
      { ...importInput(), fields: ["customer_name", "member_id", "project"] },
      { db, transport },
    ),
    /Unapply/,
  );
  await saveAccountWhatsAppStage(
    admin,
    "CLIENT_ONBOARDED",
    { site_id: 1, template_name: null, enabled: false },
    { db },
  );
  await deleteAccountWhatsAppTemplate(admin, row.name, 1, { db, transport });
  assert.equal(transport.calls.remove, 0);
  assert.equal(transport.calls.create, 0);
});

test("imported delivery uses the real AWS name and exact variable order; verified KYC never receives Pending wording", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  const transport = importedTransport();
  const row = await importAccountWhatsAppTemplate(admin, importInput(), {
    db,
    transport,
  });
  await saveAccountWhatsAppStage(
    admin,
    "CLIENT_ONBOARDED",
    { site_id: 1, template_name: row.name, enabled: true },
    { db },
  );
  await pg.exec(
    "INSERT INTO members VALUES(12,1,'New Client','9876543212',NULL,'CLIENT',ARRAY['CLIENT'],'CLT-12','ACTIVE')",
  );
  await queueAccountWhatsApp("CLIENT_ONBOARDED", 10, { siteId: 1, db });
  await queueAccountWhatsApp("CLIENT_ONBOARDED", 12, { siteId: 1, db });
  const sent = [];
  await drainAccountWhatsApp({
    db,
    transport,
    send: async (...args) => {
      sent.push(args);
      return "accepted";
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "dgg_registered_v2");
  assert.deepEqual(sent[0][2], ["New Client", "Defence Garden", "CLT-12"]);
  assert.deepEqual(
    (
      await db.query(
        "SELECT status,template,error FROM account_whatsapp_messages ORDER BY id",
      )
    ).rows.map((item) => item.status),
    ["SKIPPED", "SENT"],
  );
  assert.match(
    (
      await db.query(
        "SELECT error FROM account_whatsapp_messages ORDER BY id LIMIT 1",
      )
    ).rows[0].error,
    /KYC is already verified/,
  );
  const sample = [];
  await testAccountWhatsAppTemplate(
    admin,
    { site_id: 1, event: "CLIENT_ONBOARDED", phone: "9876543210" },
    {
      db,
      transport,
      send: async (...args) => {
        sample.push(args);
        return "sample";
      },
    },
  );
  assert.equal(sample[0][1], "dgg_registered_v2");
});

test("a changed shared AWS template blocks delivery and requires explicit mapping review", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const transport = importedTransport();
  const row = await importAccountWhatsAppTemplate(admin, importInput(), {
    db,
    transport,
  });
  await saveAccountWhatsAppStage(
    admin,
    "CLIENT_ONBOARDED",
    { site_id: 1, template_name: row.name, enabled: true },
    { db },
  );
  await queueAccountWhatsApp("CLIENT_ONBOARDED", 10, { siteId: 1, db });
  transport.definition.components[0].text += " Content changed.";
  let sent = 0;
  await drainAccountWhatsApp({
    db,
    transport,
    send: async () => {
      sent++;
    },
  });
  assert.equal(sent, 0);
  assert.match(
    (await db.query("SELECT error FROM account_whatsapp_messages")).rows[0]
      .error,
    /content changed/,
  );
  await refreshAccountWhatsAppTemplates(db, transport, 1);
  assert.equal(
    (await db.query("SELECT status FROM account_whatsapp_templates")).rows[0]
      .status,
    "CHANGED",
  );
  assert.equal(
    (await listAccountWhatsAppRemoteTemplates(admin, 1, { db, transport }))
      .templates[0].imported_events.length,
    0,
  );
  transport.definition.components[0].text =
    approvedAwsRegistration().components[0].text;
  transport.definition.category = "MARKETING";
  await refreshAccountWhatsAppTemplates(db, transport, 1);
  await refreshAccountWhatsAppTemplates(db, transport, 1);
  const changed = (
    await db.query("SELECT status,category FROM account_whatsapp_templates")
  ).rows[0];
  assert.deepEqual(changed, { status: "CHANGED", category: "UTILITY" });
  await assert.rejects(
    importAccountWhatsAppTemplate(admin, importInput(), { db, transport }),
    /Unapply/,
  );
});

test("the chosen category reaches Meta, persists on drafts and preserves rejection details", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const input = {
    site_id: 1,
    event: "CLIENT_ONBOARDED",
    title: "Welcome",
    body: ACCOUNT_WHATSAPP_EVENTS.CLIENT_ONBOARDED.body,
    category: "MARKETING",
  };
  let submitted;
  const transport = {
    ...localTransport(),
    create: async (definition) => {
      submitted = definition;
      return {
        templateStatus: "REJECTED",
        metaTemplateId: "rejected-category",
      };
    },
    rejection: async () => "INCORRECT_CATEGORY",
  };
  const rejected = await createAccountWhatsAppTemplate(admin, input, {
    db,
    transport,
  });
  assert.equal(submitted.category, "MARKETING");
  assert.equal(rejected.category, "MARKETING");
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.rejected_reason, "INCORRECT_CATEGORY");
  await assert.rejects(
    saveAccountWhatsAppStage(
      admin,
      input.event,
      { site_id: 1, template_name: rejected.name, enabled: true },
      { db },
    ),
    /approved/,
  );
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    const draft = await createAccountWhatsAppTemplate(admin, input, { db });
    assert.equal(draft.status, "DRAFT");
    assert.equal(draft.category, "MARKETING");
  } finally {
    if (previousPhoneId === undefined)
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
  }
  const count = (
    await db.query(
      "SELECT COUNT(*)::int AS count FROM account_whatsapp_templates",
    )
  ).rows[0].count;
  await assert.rejects(
    createAccountWhatsAppTemplate(
      admin,
      { ...input, category: "AUTHENTICATION" },
      { db, transport },
    ),
    /Utility or Marketing/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT COUNT(*)::int AS count FROM account_whatsapp_templates",
      )
    ).rows[0].count,
    count,
  );
});

test("payment policy always excludes CASH, unknown modes, pending and wrong direction", () => {
  const valid = { payment_mode: "BANK", status: "approved", amount: 100 };
  assert.equal(
    isAccountWhatsAppPaymentEligible(valid, "PAYMENT_RECEIVED"),
    true,
  );
  for (const change of [
    { payment_mode: "CASH" },
    { payment_mode: "" },
    { payment_mode: "BANK CASH" },
    { payment_from: "CASH" },
    { status: "pending" },
    { amount: -100 },
    { payment_mode: "CHEQUE", cheque_status: "PENDING" },
  ])
    assert.equal(
      isAccountWhatsAppPaymentEligible(
        { ...valid, ...change },
        "PAYMENT_RECEIVED",
      ),
      false,
    );
  assert.equal(
    isAccountWhatsAppPaymentEligible(
      { ...valid, amount: -100 },
      "PAYMENT_SENT",
    ),
    true,
  );
});

test("missing migration gives a usable off-by-default workspace; schema installs once without touching financial rows", async (t) => {
  const { pg, db } = await fixture(t);
  const before = (await pg.query("SELECT * FROM plot_payments")).rows;
  let state = await accountWhatsAppStudio(admin, 1, { db });
  assert.equal(state.schema_ready, false);
  assert.equal(state.stages.length, 8);
  assert.ok(
    state.stages.every((s) => !s.settings.enabled && !s.active_template),
  );
  assert.equal(await up(db), true);
  assert.equal(await up(db), false);
  state = await accountWhatsAppStudio(admin, 1, { db });
  assert.equal(state.schema_ready, true);
  assert.equal(state.policy.cash_excluded, true);
  assert.equal(state.recent.length, 0);
  assert.deepEqual(
    (await pg.query("SELECT * FROM plot_payments")).rows,
    before,
  );
  assert.equal(
    (await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db }))
      .reason,
    "stage_disabled",
  );
});

test("site and role boundaries cover every template action, preview and sample", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const input = {
    site_id: 1,
    event: "CLIENT_ONBOARDED",
    title: "Welcome",
    body: ACCOUNT_WHATSAPP_EVENTS.CLIENT_ONBOARDED.body,
  };
  for (const actor of [
    { ...admin, role: "sub_admin" },
    { ...admin, organization_id: 2 },
  ]) {
    for (const promise of [
      accountWhatsAppStudio(actor, 1, { db }),
      createAccountWhatsAppTemplate(actor, input, {
        db,
        transport: localTransport(),
      }),
      saveAccountWhatsAppStage(actor, input.event, input, { db }),
      updateAccountWhatsAppTemplate(
        actor,
        "x",
        { site_id: 1, archived: true },
        { db },
      ),
      deleteAccountWhatsAppTemplate(actor, "x", 1, { db }),
      previewAccountWhatsAppTemplate(actor, input, { db }),
      testAccountWhatsAppTemplate(
        actor,
        { ...input, phone: "9876543210" },
        { db, send: async () => "test" },
      ),
    ])
      await assert.rejects(promise, (error) => error.statusCode === 403);
  }
  const site2 = await apply(db, "CLIENT_ONBOARDED", 2);
  await assert.rejects(
    saveAccountWhatsAppStage(
      admin,
      "CLIENT_ONBOARDED",
      { site_id: 1, template_name: site2.name },
      { db },
    ),
    (error) => error.statusCode === 409,
  );
});

test("approval, explicit assignment, archive, restore and delete preserve protected versions", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  const pending = await createAccountWhatsAppTemplate(
    admin,
    {
      site_id: 1,
      event: "CLIENT_ONBOARDED",
      title: "Pending",
      body: ACCOUNT_WHATSAPP_EVENTS.CLIENT_ONBOARDED.body,
    },
    { db, transport: localTransport("PENDING") },
  );
  await assert.rejects(
    saveAccountWhatsAppStage(
      admin,
      "CLIENT_ONBOARDED",
      { site_id: 1, enabled: true, template_name: pending.name },
      { db },
    ),
    /approved/,
  );
  const active = await apply(db, "CLIENT_ONBOARDED");
  await assert.rejects(
    updateAccountWhatsAppTemplate(
      admin,
      active.name,
      { site_id: 1, archived: true },
      { db },
    ),
    /Unapply/,
  );
  await assert.rejects(
    deleteAccountWhatsAppTemplate(admin, active.name, 1, {
      db,
      transport: localTransport(),
    }),
    /Unapply/,
  );
  await saveAccountWhatsAppStage(
    admin,
    "CLIENT_ONBOARDED",
    { site_id: 1, template_name: null },
    { db },
  );
  assert.equal(
    (await accountWhatsAppStudio(admin, 1, { db })).stages[0].settings.enabled,
    false,
  );
  await pg.query(
    "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key,status) VALUES(1,'CLIENT_ONBOARDED',10,'flight','SENDING')",
  );
  await assert.rejects(
    updateAccountWhatsAppTemplate(
      admin,
      active.name,
      { site_id: 1, archived: true },
      { db },
    ),
    /sending/,
  );
  await pg.query("UPDATE account_whatsapp_messages SET status='SENT'");
  assert.ok(
    (
      await updateAccountWhatsAppTemplate(
        admin,
        active.name,
        { site_id: 1, archived: true },
        { db },
      )
    ).archived_at,
  );
  await assert.rejects(
    saveAccountWhatsAppStage(
      admin,
      "CLIENT_ONBOARDED",
      { site_id: 1, template_name: active.name },
      { db },
    ),
    /unarchived/,
  );
  await updateAccountWhatsAppTemplate(
    admin,
    active.name,
    { site_id: 1, archived: false },
    { db },
  );
  let removals = 0;
  await deleteAccountWhatsAppTemplate(admin, active.name, 1, {
    db,
    transport: { remove: async () => removals++ },
  });
  assert.equal(removals, 1);
  assert.equal(
    (
      await pg.query(
        "SELECT status FROM account_whatsapp_templates WHERE name=$1",
        [active.name],
      )
    ).rows[0].status,
    "DELETED",
  );
});

test("worker rereads current mode, amount, approval, cheque and site; queue deduplicates references", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  await apply(db, "PAYMENT_RECEIVED");
  await apply(db, "PAYMENT_SENT");
  await apply(db, "INSTALLMENT_RECEIVED");
  assert.equal(
    (await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { db })).queued,
    true,
  );
  assert.equal(
    (await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db }))
      .queued,
    false,
  );
  assert.equal(
    (await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 2, db }))
      .queued,
    false,
  );
  await pg.query("UPDATE plot_payments SET payment_type='CASH' WHERE id=40");
  const calls = [];
  const send = async (...args) => {
    calls.push(args);
    return "aws-accepted";
  };
  await drainAccountWhatsApp({ db, send, upload: async () => "test-media" });
  assert.equal(calls.length, 0);
  assert.equal(
    (await pg.query("SELECT status FROM account_whatsapp_messages")).rows[0]
      .status,
    "SKIPPED",
  );
  for (const [index, patch] of Object.entries([
    { payment_type: "BANK", status: "pending" },
    { payment_type: "BANK", cheque_status: "PENDING" },
    { payment_type: "BANK", amount: -100 },
    { payment_type: "CHEQUE", cheque_status: "BOUNCED" },
    { payment_type: "BANK", money_transfer_id: "internal" },
    { payment_type: "BANK", entry_transfer_id: "module-move" },
  ])) {
    await pg.query(
      "UPDATE plot_payments SET payment_type='BANK',status='approved',cheque_status=NULL,amount=100,money_transfer_id=NULL,entry_transfer_id=NULL",
    );
    for (const [column, value] of Object.entries(patch))
      await pg.query(`UPDATE plot_payments SET ${column}=$1`, [value]);
    assert.equal(
      (
        await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, {
          siteId: 1,
          db,
          dedupeKey: `ineligible:${index}`,
        })
      ).queued,
      false,
    );
  }
  await pg.query(
    "UPDATE plot_payments SET payment_type='CHEQUE',status='approved',cheque_status='CLEARED',amount=-100,money_transfer_id=NULL,entry_transfer_id=NULL",
  );
  assert.equal(
    (await queueAccountWhatsApp("PAYMENT_SENT", 40, { siteId: 1, db })).queued,
    true,
  );
  assert.equal(
    (await queueAccountWhatsApp("INSTALLMENT_RECEIVED", 60, { db })).queued,
    true,
    "installment site is derived from current plot",
  );
  await drainAccountWhatsApp({ db, send, upload: async () => "test-media" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "+919876543210");
  assert.equal(
    calls[0][2].find((p) => p.includes("₹")),
    "₹100.00",
  );
  assert.ok(
    (
      await pg.query(
        "SELECT status FROM account_whatsapp_messages WHERE status='SENT'",
      )
    ).rows.length === 2,
  );
});

test("booking and registry require approved booking and completed deed handover", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  assert.ok(await loadAccountWhatsAppContext("PLOT_BOOKED", 20, 1, db));
  await pg.query("UPDATE plots SET approval_status='pending'");
  assert.equal(
    await loadAccountWhatsAppContext("PLOT_BOOKED", 20, 1, db),
    null,
  );
  assert.equal(
    await loadAccountWhatsAppContext("REGISTRY_COMPLETED", 70, 1, db),
    null,
  );
  await pg.query("INSERT INTO registry_document_handovers VALUES(1,70)");
  assert.equal(
    await loadAccountWhatsAppContext("REGISTRY_COMPLETED", 70, 1, db),
    null,
  );
  await pg.query(
    "INSERT INTO documents VALUES(1,20,NULL,'BOOKING','/deed.pdf','REGISTRY')",
  );
  assert.ok(await loadAccountWhatsAppContext("REGISTRY_COMPLETED", 70, 1, db));
  await pg.query("UPDATE plot_registries SET plot_id=NULL");
  assert.ok(
    await loadAccountWhatsAppContext("REGISTRY_COMPLETED", 70, 1, db),
    "legacy registry resolves a unique same-site plot",
  );
  await pg.query(
    "INSERT INTO plots VALUES(21,1,'A12','Rahul Sharma',10,'BOOKED','approved',true)",
  );
  assert.equal(
    await loadAccountWhatsAppContext("REGISTRY_COMPLETED", 70, 1, db),
    null,
    "ambiguous legacy plot links cannot choose a recipient",
  );
  await pg.query("UPDATE plot_registries SET registry_date=NULL");
  assert.equal(
    await loadAccountWhatsAppContext("REGISTRY_COMPLETED", 70, 1, db),
    null,
  );
});

test("future reminders use canonical allocation including cash receipts; no historical or paid messages", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  await apply(db, "INSTALLMENT_DUE");
  assert.equal(
    Number(
      (await loadAccountWhatsAppContext("INSTALLMENT_DUE", 50, 1, db))
        .remaining,
    ),
    3500,
  );
  for (const status of [
    "CANCELLED",
    "COMPANY",
    "RESALE",
    "TRANSFERRED",
    "UNDER CANCELLATION",
  ]) {
    await pg.query("UPDATE plots SET status=$1", [status]);
    assert.equal(
      await loadAccountWhatsAppContext("INSTALLMENT_DUE", 50, 1, db),
      null,
    );
    assert.equal(await scheduleAccountWhatsAppReminders({ db }), 0);
  }
  await pg.query("UPDATE plots SET status='BOOKED'");
  assert.equal(await scheduleAccountWhatsAppReminders({ db }), 1);
  assert.equal(await scheduleAccountWhatsAppReminders({ db }), 0);
  // A payment after scheduling must cancel the reminder at delivery.
  await pg.query("UPDATE plot_payments SET payment_type='CASH',amount=5000");
  let sends = 0;
  await drainAccountWhatsApp({
    db,
    send: async () => {
      sends++;
      return "accepted";
    },
  });
  assert.equal(sends, 0);
  await pg.query("UPDATE plot_payments SET amount=0");
  await pg.query(
    "INSERT INTO plot_installments VALUES(51,20,'Historical',5000,CURRENT_DATE-30,1)",
  );
  assert.equal(await scheduleAccountWhatsAppReminders({ db }), 0);
  await assert.rejects(
    saveAccountWhatsAppStage(
      admin,
      "INSTALLMENT_DUE",
      { site_id: 1, lead_days: 31 },
      { db },
    ),
    /0 and 30/,
  );
});

test("sample action uses fictional values, protects in-flight version and logs provider acceptance", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const template = await apply(db, "PAYMENT_RECEIVED");
  const result = await testAccountWhatsAppTemplate(
    admin,
    { site_id: 1, event: "PAYMENT_RECEIVED", phone: "9876543212" },
    {
      db,
      upload: async () => "test-media",
      send: async (to, name, params) => {
        assert.equal(to, "+919876543212");
        assert.equal(name, template.name);
        assert.ok(params.includes("₹1,00,000.00"));
        assert.ok(params.includes("Rahul Sharma"));
        await assert.rejects(
          deleteAccountWhatsAppTemplate(admin, name, 1, {
            db,
            transport: localTransport(),
          }),
          /Unapply|sending/,
        );
        return "sample-accepted";
      },
    },
  );
  assert.equal(result.sample_only, true);
  const state = await accountWhatsAppStudio(admin, 1, { db });
  assert.equal(state.recent[0].is_test, true);
  assert.equal(state.recent[0].status, "SENT");
});

test("approval refresh keeps unsubmitted drafts and invalidates externally missing remote templates", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  await pg.query(
    "INSERT INTO account_whatsapp_templates(site_id,event,name,title,body,status) VALUES(1,'CLIENT_ONBOARDED','local_draft','Draft','Hello there.','DRAFT')",
  );
  const template = await apply(db, "CLIENT_ONBOARDED");
  await refreshAccountWhatsAppTemplates(db, localTransport(), 1);
  assert.equal(
    (
      await pg.query(
        "SELECT status FROM account_whatsapp_templates WHERE name='local_draft'",
      )
    ).rows[0].status,
    "DRAFT",
  );
  assert.equal(
    (
      await pg.query(
        "SELECT status FROM account_whatsapp_templates WHERE name=$1",
        [template.name],
      )
    ).rows[0].status,
    "MISSING",
  );
});

test("default imports, queue and startup perform no database or provider work in node test context", async () => {
  assert.equal(
    (await queueAccountWhatsApp("CLIENT_ONBOARDED", 1, { siteId: 1 })).queued,
    false,
  );
  assert.equal(await drainAccountWhatsApp(), 0);
  assert.equal(await scheduleAccountWhatsAppReminders(), 0);
  startAccountWhatsAppWorker();
  stopAccountWhatsAppWorker();
});

test("reminder pagination passes fully paid rows to reach later unpaid clients", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  await apply(db, "INSTALLMENT_DUE");
  await pg.query("UPDATE plot_payments SET amount=5000");
  await pg.query(
    "INSERT INTO plot_installments VALUES(51,20,'Installment 2',5000,(now() AT TIME ZONE 'Asia/Kolkata')::date+3,1)",
  );
  assert.equal(await scheduleAccountWhatsAppReminders({ db, scanLimit: 1 }), 1);
  assert.equal(
    Number(
      (await pg.query("SELECT ref_id FROM account_whatsapp_messages")).rows[0]
        .ref_id,
    ),
    51,
  );
});

test("queue failures roll back their savepoint while preserving a surrounding financial request", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  await apply(db, "PAYMENT_RECEIVED");
  const baseQuery = db.query;
  db.connect = async () => ({ query: baseQuery, release() {} });
  const { originalConnect } = installRequestTransactionAdapter(db);
  const context = createRequestTransaction({ connect: originalConnect });
  await requestTransactionContext.run(context, async () => {
    await db.query("UPDATE members SET full_name='Updated Client' WHERE id=10");
    // An optional legacy table disappearing makes the notification lookup fail.
    await db.query("DROP TABLE bookings");
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.equal(
        (await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db }))
          .reason,
        "error",
      );
    } finally {
      console.error = originalError;
    }
    await context.finish(true);
  });
  assert.equal(
    (await pg.query("SELECT full_name FROM members WHERE id=10")).rows[0]
      .full_name,
    "Updated Client",
  );
  assert.equal(
    (
      await pg.query(
        "SELECT count(*)::integer AS total FROM account_whatsapp_messages",
      )
    ).rows[0].total,
    0,
  );
});

test("accepted messages are never resent after log failure; expired and interrupted messages are surfaced", async (t) => {
  const { pg, db } = await fixture(t);
  await up(db);
  await apply(db, "PAYMENT_RECEIVED");
  await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { db });
  let sends = 0;
  const originalQuery = db.query;
  db.query = (sql, args = []) =>
    args[1] === "SENT" &&
    sql.startsWith("UPDATE account_whatsapp_messages SET status=$2")
      ? Promise.reject(
          new Error("Simulated log outage after provider accepted"),
        )
      : originalQuery(sql, args);
  const originalError = console.error;
  console.error = () => {};
  try {
    await drainAccountWhatsApp({
      db,
      upload: async () => "test-media",
      send: async () => {
        sends++;
        return "accepted-once";
      },
    });
  } finally {
    console.error = originalError;
    db.query = originalQuery;
  }
  assert.equal(sends, 1);
  assert.equal(
    (await pg.query("SELECT status FROM account_whatsapp_messages")).rows[0]
      .status,
    "SENDING",
  );
  await pg.query(
    "UPDATE account_whatsapp_messages SET updated_at=now()-interval '11 minutes'",
  );
  await pg.query(
    "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key,created_at) VALUES(1,'PAYMENT_RECEIVED',40,'historical',now()-interval '2 days')",
  );
  await drainAccountWhatsApp({
    db,
    send: async () => {
      sends++;
      return "should-never-send";
    },
  });
  assert.equal(sends, 1);
  assert.deepEqual(
    (
      await pg.query("SELECT status FROM account_whatsapp_messages ORDER BY id")
    ).rows.map((row) => row.status),
    ["FAILED", "EXPIRED"],
  );
});

const approvedAwsPayment = () => ({
  ...approvedAwsRegistration(),
  id: "1134147355654836",
  name: "dgg_payment_received_v1",
  components: [
    { type: "HEADER", format: "DOCUMENT" },
    {
      type: "BODY",
      text: "Dear {{1}}, payment for {{2}} received. Amount: {{3}}. Receipt: {{4}}. Date: {{5}}. Mode: {{6}}. Registration: {{7}}. Your receipt is attached.",
      example: {
        body_text: [
          [
            "Rahul Sharma",
            "Defence Garden",
            "Rs. 1,000.00",
            "ACK-40",
            "23 Oct 2026",
            "BANK",
            "CLT-10",
          ],
        ],
      },
    },
  ],
});
const paymentImport = () => ({
  site_id: 1,
  event: "PAYMENT_RECEIVED",
  meta_template_id: "1134147355654836",
  title: "Approved payment with receipt",
  fields: [
    "customer_name",
    "project",
    "amount",
    "receipt_no",
    "payment_date",
    "payment_mode",
    "registration_no",
  ],
});

test("document migration preserves existing template assignments and stays idempotent", async (t) => {
  const { db } = await fixture(t);
  await baseUp(db);
  await db.query(
    "INSERT INTO account_whatsapp_templates(site_id,event,name,title,body,status) VALUES(1,'CLIENT_ONBOARDED','existing','Existing','Existing message','APPROVED')",
  );
  await db.query(
    "INSERT INTO account_whatsapp_stage_settings(site_id,event,template_name,enabled) VALUES(1,'CLIENT_ONBOARDED','existing',false)",
  );
  assert.equal(await documentUp(db), true);
  assert.equal(await documentUp(db), false);
  assert.deepEqual(
    (await db.query("SELECT name,has_document FROM account_whatsapp_templates"))
      .rows,
    [{ name: "existing", has_document: false }],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT enabled,template_name FROM account_whatsapp_stage_settings",
      )
    ).rows,
    [{ enabled: false, template_name: "existing" }],
  );
});

test("approved PDF imports preserve seven variables, attach the canonical receipt and never submit to Meta", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const transport = importedTransport(approvedAwsPayment());
  const template = await importAccountWhatsAppTemplate(admin, paymentImport(), {
    db,
    transport,
  });
  assert.equal(template.has_document, true);
  assert.equal(transport.calls.create, 0);
  await saveAccountWhatsAppStage(
    admin,
    "PAYMENT_RECEIVED",
    { site_id: 1, template_name: template.name, enabled: true },
    { db },
  );
  await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db });
  let uploads = 0;
  const sent = [];
  const upload = async (buffer, filename) => {
    uploads++;
    assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    assert.equal(filename, "payment-receipt-ACK-40.pdf");
    return "test-media-id";
  };
  await drainAccountWhatsApp({
    db,
    transport,
    upload,
    send: async (...args) => {
      sent.push(args);
      return "accepted";
    },
  });
  assert.equal(uploads, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], "dgg_payment_received_v1");
  assert.equal(sent[0][2].length, 7);
  assert.deepEqual(sent[0][2].slice(0, 4), [
    "Rahul Sharma",
    "Defence Garden",
    "₹1,000.00",
    "ACK-40",
  ]);
  assert.deepEqual(sent[0][2].slice(5), ["BANK", "CLT-10"]);
  assert.deepEqual(sent[0][3].media, {
    type: "document",
    id: "test-media-id",
    filename: "payment-receipt-ACK-40.pdf",
  });
  assert.equal(
    (await db.query("SELECT status FROM account_whatsapp_messages")).rows[0]
      .status,
    "SENT",
  );
  const image = approvedAwsPayment();
  image.components[0].format = "IMAGE";
  assert.equal(inspectAccountWhatsAppRemoteTemplate(image).supported, false);
});

test("cash changes and attachment failures never send a payment message without its correct receipt", async (t) => {
  for (const scenario of [
    "cash_before",
    "cash_during",
    "amount_during",
    "recipient_during",
    "reference_during",
    "upload_failed",
  ]) {
    const { db } = await fixture(t);
    await up(db);
    await db.query("ALTER TABLE plot_payments ADD COLUMN bank_reference text");
    const transport = importedTransport(approvedAwsPayment());
    const template = await importAccountWhatsAppTemplate(
      admin,
      paymentImport(),
      { db, transport },
    );
    await saveAccountWhatsAppStage(
      admin,
      "PAYMENT_RECEIVED",
      { site_id: 1, template_name: template.name, enabled: true },
      { db },
    );
    await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db });
    if (scenario === "cash_before")
      await db.query(
        "UPDATE plot_payments SET payment_type='CASH',payment_from='CASH' WHERE id=40",
      );
    let uploads = 0,
      sends = 0;
    const upload = async () => {
      uploads++;
      if (scenario === "upload_failed") throw new Error("Storage unavailable");
      if (scenario === "cash_during")
        await db.query(
          "UPDATE plot_payments SET payment_type='CASH',payment_from='CASH' WHERE id=40",
        );
      if (scenario === "amount_during")
        await db.query("UPDATE plot_payments SET amount=2000 WHERE id=40");
      if (scenario === "recipient_during")
        await db.query("UPDATE members SET whatsapp='9876543219' WHERE id=10");
      if (scenario === "reference_during")
        await db.query("UPDATE plot_payments SET bank_reference='changed-reference' WHERE id=40");
      return "test-media";
    };
    await drainAccountWhatsApp({
      db,
      transport,
      upload,
      send: async () => {
        sends++;
      },
    });
    assert.equal(sends, 0, scenario);
    assert.equal(uploads, scenario === "cash_before" ? 0 : 1, scenario);
    const row = (
      await db.query("SELECT status,error FROM account_whatsapp_messages")
    ).rows[0];
    assert.equal(
      row.status,
      scenario === "upload_failed" ? "FAILED" : "SKIPPED",
      scenario,
    );
    assert.match(
      row.error,
      scenario === "upload_failed"
        ? /Storage unavailable/
        : scenario === "cash_before"
          ? /policy/
          : /Payment changed/,
    );
  }
});

test("new payment versions include a fictional PDF approval sample and a required document header", async (t) => {
  const { pg, db } = await fixture(t);
  await pg.query("UPDATE sites SET name='OM ASSOCIATES' WHERE id=1");
  await up(db);
  const definitions = [];
  let samples = 0;
  const transport = {
    ...localTransport(),
    uploadTemplateMedia: async (buffer, filename) => {
      samples++;
      assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
      assert.equal(filename, "payment-receipt-ACK-100123.pdf");
      return "approval-sample-handle";
    },
    create: async (definition) => {
      definitions.push(definition);
      return { templateStatus: "PENDING", metaTemplateId: "test-template" };
    },
  };
  for (const event of ["PAYMENT_RECEIVED", "PAYMENT_SENT", "INSTALLMENT_RECEIVED", "CLIENT_ONBOARDED"]) {
    const template = await createAccountWhatsAppTemplate(admin, {
      site_id: 1, event, title: event, body: ACCOUNT_WHATSAPP_EVENTS[event].body,
    }, { db, transport });
    const payment = event !== "CLIENT_ONBOARDED";
    assert.equal(template.has_document, payment);
    assert.equal(definitions.at(-1).components.some((component) => component.type === "HEADER"), payment);
    if (payment) assert.deepEqual(definitions.at(-1).components[0], {
      type: "HEADER", format: "DOCUMENT", example: { header_handle: ["approval-sample-handle"] },
    });
    if (payment) {
      const examples = definitions.at(-1).components.find((component) => component.type === "BODY").example.body_text[0];
      assert.ok(examples.includes("OM ASSOCIATES"), "the body sample and its receipt use the same selected project");
      assert.ok(!examples.includes("Defence Garden"));
    }
  }
  assert.equal(samples, 3);
});

test("a mapped text payment becomes a separate PDF approval version using the current site's design", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const source = approvedAwsPayment();
  source.components.shift();
  const original = structuredClone(source);
  const fields = paymentImport().fields;
  const body = source.components[0].text.replace(/\{\{(\d+)\}\}/g, (_, position) => `{${fields[Number(position) - 1]}}`);
  await db.query(
    "INSERT INTO application_settings(site_id,setting_key,setting_value) VALUES(NULL,$1,$2),(1,$3,$4),(2,$3,$2)",
    [RECEIPT_DESIGN_KEY, { non_cash: { page_size: "A4" } }, RECEIPT_SITE_DESIGN_KEY, {
      non_cash: { page_size: "A4" },
      modules: { plot_payment: { non_cash: { page_size: "A5", content: { title: "Current Site Receipt" } } } },
    }],
  );
  const preview = await previewAccountWhatsAppReceipt(admin, 1, "PAYMENT_RECEIVED", { db });
  assert.match(preview.toString("latin1"), /\/MediaBox \[0 0 419\.5\d* 595\.2\d*\]/, "preview uses the selected site's module override, ahead of shared and other-site formats");
  let definition;
  const template = await createAccountWhatsAppTemplate(admin, {
    site_id: 1, event: "PAYMENT_RECEIVED", title: "Approved payment with PDF receipt", body,
  }, { db, transport: {
    ...localTransport(),
    uploadTemplateMedia: async (buffer) => {
      assert.match(buffer.toString("latin1"), /\/MediaBox \[0 0 419\.5\d* 595\.2\d*\]/, "the Meta approval sample uses the same applied site design as preview");
      return "site-design-header";
    },
    create: async (value) => {
      definition = value;
      return { templateStatus: "PENDING", metaTemplateId: "new-document-version" };
    },
  } });
  assert.notEqual(template.name, source.name);
  assert.equal(template.has_document, true);
  assert.equal(template.status, "PENDING");
  assert.equal(template.body, body);
  assert.deepEqual(template.fields, fields);
  assert.deepEqual(definition.components[0], {
    type: "HEADER", format: "DOCUMENT", example: { header_handle: ["site-design-header"] },
  });
  assert.equal(definition.components[1].text, source.components[0].text);
  assert.deepEqual(source, original, "the already-approved AWS text template is untouched");
  await assert.rejects(saveAccountWhatsAppStage(admin, "PAYMENT_RECEIVED", {
    site_id: 1, template_name: template.name, enabled: true,
  }, { db }), /approved/i);

  // Model Meta approval in the isolated database, then change the applied design.
  // Delivery must load that new design instead of freezing the approval sample.
  await db.query("UPDATE account_whatsapp_templates SET status='APPROVED' WHERE id=$1", [template.id]);
  await db.query("UPDATE application_settings SET setting_value=$1 WHERE site_id=1 AND setting_key=$2", [
    { non_cash: { page_size: "A4" } }, RECEIPT_SITE_DESIGN_KEY,
  ]);
  await saveAccountWhatsAppStage(admin, "PAYMENT_RECEIVED", {
    site_id: 1, template_name: template.name, enabled: true,
  }, { db });
  await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db });
  let sends = 0;
  await drainAccountWhatsApp({ db,
    upload: async (buffer, filename) => {
      assert.match(buffer.toString("latin1"), /\/MediaBox \[0 0 595\.2\d* 841\.8\d*\]/, "the transaction attachment uses the latest applied site design");
      assert.equal(filename, "payment-receipt-ACK-40.pdf");
      return "current-design-media";
    },
    send: async (_phone, name, _params, options) => {
      sends++;
      assert.equal(name, template.name);
      assert.equal(options.media.id, "current-design-media");
      return "accepted-new-version";
    },
  });
  assert.equal(sends, 1);
});

test("PDF sample upload failure saves the payment version without submitting a body-only template", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  let submissions = 0;
  await assert.rejects(createAccountWhatsAppTemplate(admin, {
    site_id: 1, event: "PAYMENT_RECEIVED", title: "Payment receipt", body: ACCOUNT_WHATSAPP_EVENTS.PAYMENT_RECEIVED.body,
  }, { db, transport: {
    ...localTransport(),
    uploadTemplateMedia: async () => { throw new Error("Sample storage unavailable"); },
    create: async () => { submissions++; },
  } }), /Sample storage unavailable/);
  assert.equal(submissions, 0);
  assert.deepEqual((await db.query("SELECT status,has_document FROM account_whatsapp_templates")).rows, [
    { status: "SUBMISSION_FAILED", has_document: true },
  ]);
});

test("legacy text-only payment assignments are never sent without a PDF and can still be switched off", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const textOnlyDefinition = approvedAwsPayment();
  textOnlyDefinition.components.shift();
  await assert.rejects(importAccountWhatsAppTemplate(admin, paymentImport(), {
    db, transport: importedTransport(textOnlyDefinition),
  }), /PDF document-header/);
  assert.equal((await db.query("SELECT COUNT(*)::int AS total FROM account_whatsapp_templates")).rows[0].total, 0);
  const template = await apply(db, "PAYMENT_RECEIVED");
  await db.query("UPDATE account_whatsapp_templates SET has_document=false WHERE id=$1", [template.id]);
  await assert.rejects(saveAccountWhatsAppStage(admin, "PAYMENT_RECEIVED", {
    site_id: 1, enabled: true,
  }, { db }), /PDF document-header/);
  await assert.rejects(testAccountWhatsAppTemplate(admin, {
    site_id: 1, event: "PAYMENT_RECEIVED", phone: "9876543210",
  }, { db, send: async () => assert.fail("must not send") }), /PDF document-header/);
  assert.equal((await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db })).queued, true);
  await drainAccountWhatsApp({ db, send: async () => assert.fail("must not send"), upload: async () => assert.fail("must not upload") });
  assert.deepEqual((await db.query("SELECT status FROM account_whatsapp_messages")).rows, [{ status: "SKIPPED" }]);
  assert.match((await db.query("SELECT error FROM account_whatsapp_messages")).rows[0].error, /document-header/);
  assert.equal((await saveAccountWhatsAppStage(admin, "PAYMENT_RECEIVED", { site_id: 1, enabled: false }, { db })).enabled, false);
});

test("receipt context reads the exact transaction and site-owned printable facts without member KYC", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  await db.query("ALTER TABLE plot_payments ADD COLUMN bank_reference text,ADD COLUMN narration text");
  await db.query("ALTER TABLE plots ADD COLUMN plot_size numeric,ADD COLUMN plot_rate numeric,ADD COLUMN booking_by text");
  await db.query("ALTER TABLE members ADD COLUMN team text,ADD COLUMN aadhar_no text");
  await db.query("UPDATE plot_payments SET bank_reference='REF-40',narration='First installment' WHERE id=40");
  await db.query("UPDATE plots SET plot_size=120,plot_rate=2000,booking_by='Sample Broker' WHERE id=20");
  await db.query("INSERT INTO members(id,site_id,full_name,phone,member_type,member_types,team) VALUES(12,1,'Sample Broker','9876543298','AGENT',ARRAY['AGENT'],'Site team'),(13,2,'Sample Broker','9876543299','AGENT',ARRAY['AGENT'],'Other team')");
  await db.query("CREATE TABLE bank_accounts(id integer,site_id integer,name text); CREATE TABLE cash_flow_entries(id integer,site_id integer,source_module text,source_id integer,bank_account_id integer)");
  await db.query("INSERT INTO bank_accounts VALUES(1,1,'Site bank'),(2,2,'Wrong site bank'); INSERT INTO cash_flow_entries VALUES(1,1,'plot_payments',40,1),(2,2,'plot_payments',40,2),(3,1,'plot_installment_payments',40,2)");
  const data = await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db);
  assert.equal(data.receipt_module, "plot_payment");
  assert.equal(data.source_id, 40);
  assert.equal(data.bank_reference, "REF-40");
  assert.equal(data.narration, "First installment");
  assert.equal(data.bank_account_name, "Site bank");
  assert.equal(data.plot_size, "120");
  assert.equal(data.plot_rate, "2000");
  assert.equal(data.broker_phone, "9876543298");
  assert.equal(data.broker_team, "Site team");
  assert.equal(Object.hasOwn(data, "aadhar_no"), false);
  assert.equal(await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 2, db), null);
  const installment = await loadAccountWhatsAppContext("INSTALLMENT_RECEIVED", 60, 1, db);
  assert.equal(installment.receipt_module, "plot_installment_payment");
  assert.equal(installment.receipt_no, "ACK-60");
  await db.query("INSERT INTO members(id,site_id,full_name,phone,member_type) VALUES(14,1,'Sample Broker','9876543297','AGENT')");
  assert.equal((await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db)).broker_phone, null, "ambiguous name never selects a broker's contact details");
});

test("receipt images use saved print history only for the same organization, site and native transaction", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  await db.query("ALTER TABLE plot_payments ADD COLUMN customer_signature_url text,ADD COLUMN authority_signature_url text,ADD COLUMN evidence_photo_url text,ADD COLUMN voucher_url text");
  await db.query(`CREATE TABLE transaction_receipts(organization_id integer,site_id integer,module text,record_id text,customer_signature_url text,authority_signature_url text,evidence_photo_url text);
    INSERT INTO transaction_receipts VALUES
    (1,2,'plot_payment','40','wrong-site','wrong-site','wrong-site'),
    (2,1,'plot_payment','40','wrong-company','wrong-company','wrong-company'),
    (1,1,'plot_installment_payment','40','wrong-module','wrong-module','wrong-module'),
    (1,1,'plot_payment','41','wrong-record','wrong-record','wrong-record'),
    (1,1,'plot_payment','40','saved-customer','saved-authority','saved-proof')`);
  const saved = await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db);
  assert.equal(saved.customer_signature_url, "saved-customer");
  assert.equal(saved.authority_signature_url, "saved-authority");
  assert.equal(saved.evidence_photo_url, "saved-proof");
  await db.query("UPDATE plot_payments SET customer_signature_url='recorded-customer',authority_signature_url=' ',voucher_url='recorded-proof' WHERE id=40");
  const recorded = await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db);
  assert.equal(recorded.customer_signature_url, "recorded-customer", "the native payment's signature takes precedence");
  assert.equal(recorded.authority_signature_url, "saved-authority", "blank source signatures allow the saved image fallback");
  assert.equal(recorded.evidence_photo_url, null, "a recorded voucher takes precedence over history evidence");
  assert.equal(recorded.voucher_url, "recorded-proof");
  await db.query("DELETE FROM transaction_receipts WHERE organization_id=1 AND site_id=1 AND module='plot_payment' AND record_id='40'");
  const isolated = await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db);
  assert.equal(isolated.authority_signature_url, " ", "other site, company, module and record IDs never supply receipt images");
});

test("document samples contain only fictional values and use an explicit media header", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  const transport = importedTransport(approvedAwsPayment());
  const template = await importAccountWhatsAppTemplate(admin, paymentImport(), {
    db,
    transport,
  });
  await saveAccountWhatsAppStage(
    admin,
    "PAYMENT_RECEIVED",
    { site_id: 1, template_name: template.name },
    { db },
  );
  const sent = [];
  let filename;
  await testAccountWhatsAppTemplate(
    admin,
    { site_id: 1, event: "PAYMENT_RECEIVED", phone: "9876543210" },
    {
      db,
      transport,
      upload: async (buffer, name) => {
        filename = name;
        assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
        return "sample-media";
      },
      send: async (...args) => {
        sent.push(args);
        return "sample-accepted";
      },
    },
  );
  assert.equal(filename, "payment-receipt-ACK-100123.pdf");
  assert.equal(sent[0][3].media.id, "sample-media");
  assert.equal(sent[0][2][3], "ACK-100123");
});

test("receipt enrichment resolves buyer, related client, approver and full bank facts from the exact site and module", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  await db.query("ALTER TABLE plots ADD COLUMN buyer_phone text");
  await db.query("ALTER TABLE plot_payments ADD COLUMN assigned_admin_id integer,ADD COLUMN booking_reference text,ADD COLUMN booking_no text,ADD COLUMN plot_reference text,ADD COLUMN bank_account_no text,ADD COLUMN account_no text");
  await db.query("ALTER TABLE plot_installment_payments ADD COLUMN assigned_admin_id integer");
  await db.query("ALTER TABLE users ADD COLUMN name text,ADD COLUMN organization_id integer");
  await db.query("UPDATE users SET name='Site Approver',organization_id=1 WHERE id=1");
  await db.query("INSERT INTO users VALUES(2,'Other Organization Approver',2)");
  await db.query("UPDATE plots SET buyer_phone='9876543280' WHERE id=20");
  await db.query("UPDATE plot_payments SET assigned_admin_id=1,booking_reference='BK-40',booking_no='BOOK-40',plot_reference='UNIT-A12',bank_account_no='OLD-ACCOUNT',account_no='OLD-ACCOUNT' WHERE id=40");
  await db.query("UPDATE plot_installment_payments SET assigned_admin_id=1 WHERE id=60");
  await db.query("INSERT INTO members(id,site_id,full_name,phone,member_type) VALUES(14,1,'Linked Client','9876543281','CLIENT')");
  await db.query("CREATE TABLE transaction_party_links(source_key text,source_id integer,site_id integer,member_id integer)");
  await db.query("INSERT INTO transaction_party_links VALUES('plot_payment',40,2,11),('plot_installment_payment',40,1,10),('plot_payment',40,1,14),('plot_installment_payment',60,1,10)");
  await db.query("CREATE TABLE bank_accounts(id integer,site_id integer,name text,account_no text,ifsc text,branch text); CREATE TABLE cash_flow_entries(id integer,site_id integer,source_module text,source_id integer,bank_account_id integer)");
  await db.query("INSERT INTO bank_accounts VALUES(1,1,'Mapped Bank','SITE-ACCOUNT','SITE0001234','Site Branch'),(2,2,'Foreign Bank','FOREIGN-ACCOUNT','OTHER000123','Other Branch'); INSERT INTO cash_flow_entries VALUES(1,1,'plot_payments',40,1),(2,2,'plot_payments',40,2),(3,1,'plot_installment_payments',60,2)");
  const data = await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db);
  assert.equal(data.buyer_phone, "9876543280");
  assert.equal(data.related_party, "Linked Client");
  assert.equal(data.assigned_to, "Site Approver");
  assert.equal(data.booking_reference, "BK-40");
  assert.equal(data.booking_no, "BOOK-40");
  assert.equal(data.plot_reference, "UNIT-A12");
  assert.equal(data.bank_account_name, "Mapped Bank");
  assert.equal(data.bank_name, "Mapped Bank");
  assert.equal(data.bank_account_no, "SITE-ACCOUNT");
  assert.equal(data.account_no, "SITE-ACCOUNT");
  assert.equal(data.bank_ifsc, "SITE0001234");
  assert.equal(data.ifsc, "SITE0001234");
  assert.equal(data.branch, "Site Branch");
  const installment = await loadAccountWhatsAppContext("INSTALLMENT_RECEIVED", 60, 1, db);
  assert.equal(installment.related_party, "Rahul Sharma", "installment identity resolves its own related-client link");
  assert.equal(installment.assigned_to, "Site Approver");
  assert.equal(installment.bank_account_name, null, "foreign-site bank mapping is ignored");
  await db.query("UPDATE plots SET buyer_phone=' ' WHERE id=20; UPDATE plot_payments SET assigned_admin_id=2 WHERE id=40; UPDATE transaction_party_links SET member_id=11 WHERE source_key='plot_payment' AND source_id=40 AND site_id=1; UPDATE bank_accounts SET account_no=NULL,ifsc=NULL,branch=NULL WHERE id=1");
  const changed = await loadAccountWhatsAppContext("PAYMENT_RECEIVED", 40, 1, db);
  assert.equal(changed.buyer_phone, "9876543210", "blank plot phone falls back to the linked buyer member");
  assert.equal(changed.related_party, "", "foreign-site clients cannot supply a printed related-party name");
  assert.equal(changed.assigned_to, "", "foreign-organization users cannot supply the approver name");
  assert.equal(changed.bank_account_no, null, "mapped banks do not inherit a stale source account number");
  assert.equal(changed.account_no, null);
  assert.equal(changed.ifsc, null);
  assert.equal(changed.branch, null);
});
