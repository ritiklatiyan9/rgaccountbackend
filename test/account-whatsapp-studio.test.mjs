import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { up } from "../src/migrations/225_account_whatsapp_studio.js";
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
} from "../src/services/accountWhatsApp.service.js";
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
  assert.match(
    inspectAccountWhatsAppRemoteTemplate(media).unsupported_reason,
    /attachment/,
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
    /attachment/,
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
  await drainAccountWhatsApp({ db, send });
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
  await drainAccountWhatsApp({ db, send });
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
