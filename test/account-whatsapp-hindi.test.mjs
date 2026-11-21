import test from "node:test";
import assert from "node:assert/strict";
import { up as baseUp } from "../src/migrations/225_account_whatsapp_studio.js";
import { up as documentUp } from "../src/migrations/226_account_whatsapp_documents.js";
import { up as hindiUp } from "../src/migrations/246_account_whatsapp_hindi.js";
import {
  ACCOUNT_WHATSAPP_EVENTS,
  accountWhatsAppHindiEnabled,
  accountWhatsAppHindiReady,
  accountWhatsAppStudio,
  createAccountWhatsAppTemplate,
  drainAccountWhatsApp,
  queueAccountWhatsApp,
  saveAccountWhatsAppLanguages,
  saveAccountWhatsAppStage,
  scheduleAccountWhatsAppOverdue,
  scheduleAccountWhatsAppReminders,
  testAccountWhatsAppTemplate,
  updateAccountWhatsAppTemplate,
} from "../src/services/accountWhatsApp.service.js";
import {
  accountWhatsAppLanguage,
  accountWhatsAppLanguageGroup,
  compileAccountWhatsAppBody,
} from "../src/services/accountWhatsApp.spec.js";
import {
  overdueTemplateBody,
  overdueTemplateBodyHi,
} from "../src/services/installmentOverduePolicy.service.js";
import { accountTemplateStatesPendingKyc } from "../src/services/accountWhatsAppImport.spec.js";
import { approvingTransport, fixture } from "./helpers/account-whatsapp-fixture.mjs";

const admin = { id: 1, role: "admin", organization_id: 1 };
const DEVANAGARI = /[ऀ-ॿ]/;

/** Schema through migration 246, one module with English and Hindi templates applied. */
async function setup(t, { event = "KYC_VERIFIED", hindiSwitch = true, migrate = true } = {}) {
  const { pg, db } = await fixture(t);
  await baseUp(db);
  await documentUp(db);
  if (migrate) await hindiUp(db);
  const transport = approvingTransport();
  const create = (language, body) =>
    createAccountWhatsAppTemplate(
      admin,
      { site_id: 1, event, title: `${event} ${language || "en"}`, body, language },
      { db, transport },
    );
  const en = await create(undefined, ACCOUNT_WHATSAPP_EVENTS[event].body);
  const hi = migrate ? await create("hi", ACCOUNT_WHATSAPP_EVENTS[event].body_hi) : null;
  await saveAccountWhatsAppStage(
    admin,
    event,
    {
      site_id: 1,
      template_name: en.name,
      enabled: true,
      ...(hi ? { template_name_hi: hi.name } : {}),
    },
    { db },
  );
  if (migrate && hindiSwitch)
    await saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: true }, { db });
  return { pg, db, transport, en, hi, create };
}
/** A provider double that records every message and the log status at the moment it was sent. */
function provider(pg, { failFor = () => false } = {}) {
  const calls = [];
  const send = async (to, name, params, options = {}) => {
    const id = Number(String(options.ref).split(":").at(-1));
    const logged = (await pg.query("SELECT * FROM account_whatsapp_messages WHERE id=$1", [id])).rows[0];
    calls.push({ to, name, params, language: options.language, media: options.media, logged });
    if (failFor(name)) throw Object.assign(new Error("Provider refused"), { name: "ProviderError" });
    return `aws-${calls.length}`;
  };
  let uploads = 0;
  const upload = async () => `media-${++uploads}`;
  return { calls, send, upload };
}
const log = async (pg) =>
  (
    await pg.query(
      "SELECT dedupe_key,language,status,template,error FROM account_whatsapp_messages ORDER BY id",
    )
  ).rows;

test("migration 246 adds only the Hindi columns, enables nothing and is idempotent", async (t) => {
  const { pg, db } = await fixture(t);
  await baseUp(db);
  await documentUp(db);
  const columns = async () =>
    (
      await pg.query(
        "SELECT table_name||'.'||column_name AS name FROM information_schema.columns WHERE table_name LIKE 'account_whatsapp%'",
      )
    ).rows.map((row) => row.name);
  const before = await columns();
  assert.equal(await accountWhatsAppHindiReady(db), false);
  await pg.query(
    "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key,status) VALUES(1,'KYC_VERIFIED',30,'KYC_VERIFIED:30','SENT')",
  );
  assert.equal(await hindiUp(db), true);
  assert.equal(await hindiUp(db), false);
  assert.equal(await accountWhatsAppHindiReady(db), true);
  assert.deepEqual((await columns()).filter((name) => !before.includes(name)).sort(), [
    "account_whatsapp_messages.language",
    "account_whatsapp_stage_settings.template_name_hi",
  ]);
  assert.equal(
    (await pg.query("SELECT language FROM account_whatsapp_messages")).rows[0].language,
    "en",
    "existing log rows are English",
  );
  assert.equal(
    (await pg.query("SELECT count(*)::int AS n FROM account_whatsapp_stage_settings")).rows[0].n,
    0,
    "no stage is created or enabled",
  );
  assert.equal(await accountWhatsAppHindiEnabled(1, db), false);
});

test("every default Hindi text meets Meta's rules and carries exactly the English fields", () => {
  for (const [event, spec] of Object.entries(ACCOUNT_WHATSAPP_EVENTS)) {
    assert.match(spec.body_hi, DEVANAGARI, event);
    const english = compileAccountWhatsAppBody(event, spec.body);
    const hindi = compileAccountWhatsAppBody(event, spec.body_hi);
    assert.ok(hindi.text.length <= 1024, event);
    assert.deepEqual([...new Set(hindi.fields)].sort(), [...new Set(english.fields)].sort(), event);
  }
  for (const policy of [
    { kind: "annual_interest", annual_rate: 18 },
    { kind: "shop_price_increase", amount: 50000, frequency: "once_per_shop" },
    { kind: "shop_price_increase", amount: 50000, frequency: "per_installment" },
  ]) {
    const english = compileAccountWhatsAppBody("INSTALLMENT_OVERDUE", overdueTemplateBody(policy));
    const hindi = compileAccountWhatsAppBody("INSTALLMENT_OVERDUE", overdueTemplateBodyHi(policy));
    assert.deepEqual([...new Set(hindi.fields)].sort(), [...new Set(english.fields)].sort(), policy.kind);
  }
  assert.match(overdueTemplateBodyHi({ kind: "annual_interest", annual_rate: 21 }), /21%/);
  assert.match(overdueTemplateBodyHi({ kind: "shop_price_increase", amount: 50000, frequency: "once_per_shop" }), /50,000.*एक बार/);
});

test("language codes: English variants group together, unknown languages are refused", () => {
  assert.equal(accountWhatsAppLanguage(), "en");
  assert.equal(accountWhatsAppLanguage(" HI "), "hi");
  for (const bad of ["fr", "hindi", 5, {}]) assert.throws(() => accountWhatsAppLanguage(bad), /English or Hindi/);
  assert.equal(accountWhatsAppLanguageGroup("en_US"), "en");
  assert.equal(accountWhatsAppLanguageGroup("hi"), "hi");
  assert.equal(accountWhatsAppLanguageGroup(undefined), "en");
  assert.equal(accountTemplateStatesPendingKyc("*KYC स्थिति:* लंबित"), true);
  assert.equal(accountTemplateStatesPendingKyc("आपका KYC सत्यापन पूर्ण हो गया है"), false);
});

test("a Hindi template is submitted to Meta in Hindi; English templates are unchanged; migration 246 is required", async (t) => {
  const { db, transport, en, hi } = await setup(t, { hindiSwitch: false });
  assert.equal(en.language, "en");
  assert.equal(hi.language, "hi");
  assert.match(hi.name, /^dgg_acc_s1_kyc_verified_hi_[0-9a-f]{12}$/);
  assert.doesNotMatch(en.name, /_hi_/);
  assert.deepEqual(
    transport.created.map((definition) => definition.language),
    ["en", "hi"],
  );
  assert.match(transport.created[1].components.at(-1).text, DEVANAGARI);
  assert.ok(hi.fields.includes("member_id"));
  await assert.rejects(
    createAccountWhatsAppTemplate(
      admin,
      { site_id: 1, event: "KYC_VERIFIED", title: "x", body: ACCOUNT_WHATSAPP_EVENTS.KYC_VERIFIED.body_hi, language: "fr" },
      { db, transport },
    ),
    /English or Hindi/,
  );
  const old = await setup(t, { migrate: false });
  await assert.rejects(
    createAccountWhatsAppTemplate(
      admin,
      { site_id: 1, event: "KYC_VERIFIED", title: "Hindi", body: ACCOUNT_WHATSAPP_EVENTS.KYC_VERIFIED.body_hi, language: "hi" },
      { db: old.db, transport: old.transport },
    ),
    /migration 246/,
  );
});

test("the Hindi slot only accepts an approved, unarchived Hindi template of the same module", async (t) => {
  const { db, transport, en, hi, create } = await setup(t, { hindiSwitch: false });
  const save = (body) =>
    saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, ...body }, { db });
  assert.equal((await save({})).template_name_hi, hi.name, "an unrelated save keeps the Hindi assignment");
  await assert.rejects(save({ template_name_hi: en.name }), /written in Hindi/);
  await assert.rejects(save({ template_name: hi.name }), /Hindi template/);
  await assert.rejects(save({ template_name_hi: "missing" }), /approved, unarchived Hindi/);
  const pending = await createAccountWhatsAppTemplate(
    admin,
    { site_id: 1, event: "KYC_VERIFIED", title: "Pending Hindi", body: ACCOUNT_WHATSAPP_EVENTS.KYC_VERIFIED.body_hi, language: "hi" },
    { db, transport: approvingTransport("PENDING") },
  );
  await assert.rejects(save({ template_name_hi: pending.name }), /approved, unarchived Hindi/);
  const other = await createAccountWhatsAppTemplate(
    admin,
    { site_id: 1, event: "PLOT_BOOKED", title: "Booking Hindi", body: ACCOUNT_WHATSAPP_EVENTS.PLOT_BOOKED.body_hi, language: "hi" },
    { db, transport },
  );
  await assert.rejects(save({ template_name_hi: other.name }), /approved, unarchived Hindi/);
  // The Hindi version is protected while applied, in either slot's archive/delete path.
  await assert.rejects(updateAccountWhatsAppTemplate(admin, hi.name, { site_id: 1, archived: true }, { db }), /Unapply/);
  const second = await create("hi", ACCOUNT_WHATSAPP_EVENTS.KYC_VERIFIED.body_hi);
  assert.equal((await save({ template_name_hi: second.name })).template_name_hi, second.name);
  assert.equal(
    (await updateAccountWhatsAppTemplate(admin, hi.name, { site_id: 1, archived: true }, { db })).archived_at !== null,
    true,
    "the replaced Hindi version can now be archived",
  );
  assert.equal((await save({ template_name_hi: null })).template_name_hi, null);
  assert.equal((await save({})).template_name, en.name, "removing Hindi leaves English applied");
});

test("a Hindi template that stops being approved never blocks pausing the module or the English message", async (t) => {
  const { pg, db, en, hi } = await setup(t);
  await pg.query("UPDATE account_whatsapp_templates SET status='MISSING' WHERE id=$1", [hi.id]);
  const paused = await saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, enabled: false }, { db });
  assert.equal(paused.enabled, false);
  assert.equal(paused.template_name_hi, hi.name, "the Hindi assignment is kept, not silently dropped");
  await saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, enabled: true }, { db });
  await assert.rejects(
    saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, template_name_hi: hi.name }, { db }),
    /approved, unarchived Hindi/,
    "explicitly applying it again is still refused",
  );
  await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
  const { calls, send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  assert.deepEqual(calls.map((call) => [call.name, call.language]), [[en.name, "en"]]);
  assert.deepEqual(
    (await log(pg)).map((row) => [row.language, row.status, row.error]),
    [["en", "SENT", null], ["hi", "SKIPPED", "No approved, unarchived Hindi template is applied"]],
    "the skipped Hindi message is visible in the activity log",
  );
});

test("payment modules only accept Hindi templates that carry the receipt PDF", async (t) => {
  const { pg, db, hi } = await setup(t, { event: "PAYMENT_RECEIVED", hindiSwitch: false });
  assert.equal(hi.has_document, true, "created with the receipt header");
  await pg.query(
    `INSERT INTO account_whatsapp_templates(site_id,event,name,title,body,fields,language,status,category,has_document)
     VALUES(1,'PAYMENT_RECEIVED','text_only_hi','Text only','x','{}','hi','APPROVED','UTILITY',false)`,
  );
  await assert.rejects(
    saveAccountWhatsAppStage(admin, "PAYMENT_RECEIVED", { site_id: 1, template_name_hi: "text_only_hi" }, { db }),
    /PDF document-header/,
  );
});

test("a project's Hindi switch is admin-only, site-scoped, validated and persisted", async (t) => {
  const { pg, db } = await setup(t, { hindiSwitch: false });
  assert.equal(await accountWhatsAppHindiEnabled(1, db), false);
  await assert.rejects(saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: "yes" }, { db }), /true or false/);
  await assert.rejects(saveAccountWhatsAppLanguages({ ...admin, role: "sub_admin" }, { site_id: 1, hindi: true }, { db }), /administrators/);
  await assert.rejects(saveAccountWhatsAppLanguages(admin, { site_id: 3, hindi: true }, { db }), /not found or unavailable/);
  assert.deepEqual(await saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: true }, { db }), { site_id: 1, hindi_enabled: true });
  assert.equal(await accountWhatsAppHindiEnabled(1, db), true);
  assert.equal(await accountWhatsAppHindiEnabled(2, db), false, "other projects are untouched");
  await saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: false }, { db });
  assert.equal(await accountWhatsAppHindiEnabled(1, db), false);
  assert.equal(
    (await pg.query("SELECT count(*)::int AS n FROM application_settings WHERE setting_key='account_whatsapp_hindi_v1'")).rows[0].n,
    1,
    "one setting row, updated in place",
  );
  const old = await setup(t, { migrate: false });
  await assert.rejects(saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: true }, { db: old.db }), /migration 246/);
});

test("a verified-KYC message goes out in English then Hindi, each logged on its own row", async (t) => {
  const { pg, db, en, hi } = await setup(t);
  assert.equal((await queueAccountWhatsApp("KYC_VERIFIED", 30, { db })).queued, true);
  const { calls, send, upload } = provider(pg);
  assert.equal(await drainAccountWhatsApp({ db, send, upload }), 1, "one queued message, one claim");
  assert.deepEqual(
    calls.map((call) => [call.name, call.language, call.to]),
    [
      [en.name, "en", "+919876543210"],
      [hi.name, "hi", "+919876543210"],
    ],
  );
  assert.equal(calls[1].params[0], "Rahul Sharma");
  assert.equal(calls[1].logged.status, "SENDING", "the Hindi row is never claimable while in flight");
  assert.equal(calls[1].logged.language, "hi");
  assert.deepEqual(await log(pg), [
    { dedupe_key: "KYC_VERIFIED:30", language: "en", status: "SENT", template: en.name, error: null },
    { dedupe_key: "KYC_VERIFIED:30#hi", language: "hi", status: "SENT", template: hi.name, error: null },
  ]);
  assert.equal(await drainAccountWhatsApp({ db, send, upload }), 0);
  assert.equal(calls.length, 2, "nothing is sent twice");
  // A repeat of the same event is a duplicate and produces neither language.
  assert.equal((await queueAccountWhatsApp("KYC_VERIFIED", 30, { db })).queued, false);
});

test("Hindi follows only when the project switch is on and the module has a Hindi template", async (t) => {
  for (const scenario of ["switch_off", "no_hindi_template", "switch_turned_off_again"]) {
    const { pg, db } = await setup(t, { hindiSwitch: scenario !== "switch_off" });
    if (scenario === "no_hindi_template")
      await saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, template_name_hi: null }, { db });
    if (scenario === "switch_turned_off_again")
      await saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: false }, { db });
    await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
    const { calls, send, upload } = provider(pg);
    await drainAccountWhatsApp({ db, send, upload });
    assert.deepEqual(calls.map((call) => call.language), ["en"], scenario);
    assert.deepEqual((await log(pg)).map((row) => row.language), ["en"], scenario);
  }
});

test("Hindi is never sent alone: a blocked or number-less message produces no Hindi row", async (t) => {
  const { pg, db } = await setup(t);
  await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
  await pg.query("UPDATE members SET phone='12345',whatsapp=NULL WHERE id=10");
  const { calls, send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    (await log(pg)).map((row) => [row.dedupe_key, row.status]),
    [["KYC_VERIFIED:30", "SKIPPED"]],
  );
});

test("each language fails or succeeds on its own and a retry never duplicates a message", async (t) => {
  {
    const { pg, db, en } = await setup(t);
    await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
    const { calls, send, upload } = provider(pg, { failFor: (name) => name === en.name });
    await drainAccountWhatsApp({ db, send, upload });
    assert.equal(calls.length, 2, "an English failure does not stop the Hindi attempt");
    assert.deepEqual((await log(pg)).map((row) => [row.language, row.status]), [["en", "FAILED"], ["hi", "SENT"]]);
    assert.match((await log(pg))[0].error, /Provider refused/);
  }
  {
    const { pg, db, hi } = await setup(t);
    await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
    const { calls, send, upload } = provider(pg, { failFor: (name) => name === hi.name });
    await drainAccountWhatsApp({ db, send, upload });
    assert.equal(calls.length, 2);
    assert.deepEqual((await log(pg)).map((row) => [row.language, row.status]), [["en", "SENT"], ["hi", "FAILED"]]);
  }
  {
    // The Hindi row already exists (an earlier attempt): it is left exactly as it was.
    const { pg, db } = await setup(t);
    await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
    await pg.query(
      "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key,language,status) VALUES(1,'KYC_VERIFIED',30,'KYC_VERIFIED:30#hi','hi','FAILED')",
    );
    const { calls, send, upload } = provider(pg);
    await drainAccountWhatsApp({ db, send, upload });
    assert.deepEqual(calls.map((call) => call.language), ["en"]);
    assert.equal((await log(pg)).find((row) => row.language === "hi").status, "FAILED");
  }
});

test("payment messages attach the receipt PDF to the Hindi message too", async (t) => {
  const { pg, db, en, hi } = await setup(t, { event: "PAYMENT_RECEIVED" });
  assert.equal((await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db })).queued, true);
  const { calls, send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  assert.deepEqual(calls.map((call) => [call.name, call.language]), [[en.name, "en"], [hi.name, "hi"]]);
  assert.deepEqual(
    calls.map((call) => call.media?.type),
    ["document", "document"],
  );
  assert.notEqual(calls[0].media.id, calls[1].media.id, "each message uploads its own PDF");
  assert.deepEqual((await log(pg)).map((row) => [row.language, row.status]), [["en", "SENT"], ["hi", "SENT"]]);
  // Cash can send both configured language variants.
  await pg.query("UPDATE plot_payments SET payment_type='CASH',payment_from='CASH' WHERE id=40");
  assert.equal((await queueAccountWhatsApp("PAYMENT_RECEIVED", 40, { siteId: 1, db, dedupeKey: "cash" })).queued, true);
  await drainAccountWhatsApp({ db, send, upload });
  assert.equal(calls.length, 4);
});

test("installment reminders keep their due-date check for both languages", async (t) => {
  const { pg, db, en, hi } = await setup(t, { event: "INSTALLMENT_DUE" });
  assert.equal(await scheduleAccountWhatsAppReminders({ db }), 1);
  const due = (await pg.query("SELECT due_date::text AS d FROM plot_installments WHERE id=50")).rows[0].d;
  const { calls, send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  assert.deepEqual(calls.map((call) => [call.name, call.language]), [[en.name, "en"], [hi.name, "hi"]]);
  assert.deepEqual(
    (await log(pg)).map((row) => [row.dedupe_key, row.status]),
    [[`INSTALLMENT_DUE:50:${due}`, "SENT"], [`INSTALLMENT_DUE:50:${due}#hi`, "SENT"]],
  );
  assert.equal(await scheduleAccountWhatsAppReminders({ db }), 0, "the reminder is not scheduled again");
});

test("overdue notices send in both languages on the first overdue day and never again", async (t) => {
  const { pg, db } = await fixture(t);
  await baseUp(db);
  await documentUp(db);
  await hindiUp(db);
  const policy = { enabled: true, kind: "annual_interest", annual_rate: 18, frequency: "per_installment" };
  await pg.query("INSERT INTO application_settings(site_id,setting_key,setting_value) VALUES(1,'installment_overdue_notice_policy_v1',$1)", [policy]);
  await pg.query("ALTER TABLE plots ADD COLUMN unit_type text DEFAULT 'plot'");
  await pg.query("UPDATE plot_installments SET due_date=(now() AT TIME ZONE 'Asia/Kolkata')::date-1 WHERE id=50");
  const transport = approvingTransport();
  const make = (language, body) =>
    createAccountWhatsAppTemplate(admin, { site_id: 1, event: "INSTALLMENT_OVERDUE", title: `Overdue ${language || "en"}`, body, language }, { db, transport });
  const en = await make(undefined, overdueTemplateBody(policy));
  const hi = await make("hi", overdueTemplateBodyHi(policy));
  await saveAccountWhatsAppStage(admin, "INSTALLMENT_OVERDUE", { site_id: 1, template_name: en.name, template_name_hi: hi.name, enabled: true }, { db });
  await saveAccountWhatsAppLanguages(admin, { site_id: 1, hindi: true }, { db });
  await pg.query("UPDATE account_whatsapp_stage_settings SET enabled_at=now()-interval '2 days' WHERE event='INSTALLMENT_OVERDUE'");
  assert.equal(await scheduleAccountWhatsAppOverdue({ db }), 1);
  const { calls, send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  assert.deepEqual(calls.map((call) => [call.name, call.language]), [[en.name, "en"], [hi.name, "hi"]]);
  assert.match(calls[1].params.join(" "), /Installment 1/);
  assert.deepEqual((await log(pg)).map((row) => row.status), ["SENT", "SENT"]);
  assert.equal(await scheduleAccountWhatsAppOverdue({ db }), 0);
});

test("a sample can be sent in Hindi and records its language; a module without Hindi explains why not", async (t) => {
  const { pg, db, hi } = await setup(t, { hindiSwitch: false });
  const seen = [];
  const send = async (to, name, params, options) => {
    seen.push([to, name, options.language]);
    return "accepted";
  };
  const result = await testAccountWhatsAppTemplate(admin, { site_id: 1, event: "KYC_VERIFIED", phone: "9876543212", language: "hi" }, { db, send });
  assert.deepEqual([result.language, result.template, result.sample_only], ["hi", hi.name, true]);
  assert.deepEqual(seen, [["+919876543212", hi.name, "hi"]]);
  const english = await testAccountWhatsAppTemplate(admin, { site_id: 1, event: "KYC_VERIFIED", phone: "9876543212" }, { db, send });
  assert.equal(english.language, "en");
  assert.deepEqual(
    (await pg.query("SELECT language,is_test,status FROM account_whatsapp_messages ORDER BY id")).rows,
    [{ language: "hi", is_test: true, status: "SENT" }, { language: "en", is_test: true, status: "SENT" }],
  );
  await saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, template_name_hi: null }, { db });
  await assert.rejects(
    testAccountWhatsAppTemplate(admin, { site_id: 1, event: "KYC_VERIFIED", phone: "9876543212", language: "hi" }, { db, send }),
    /Apply an approved Hindi template/,
  );
  await assert.rejects(
    testAccountWhatsAppTemplate(admin, { site_id: 1, event: "KYC_VERIFIED", phone: "9876543212", language: "fr" }, { db, send }),
    /English or Hindi/,
  );
});

test("the studio reports Hindi availability, defaults, assignments and the language of each message", async (t) => {
  const { pg, db, hi } = await setup(t);
  await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
  const { send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  const studio = await accountWhatsAppStudio(admin, 1, { db });
  assert.deepEqual(studio.languages.available.map((language) => language.code), ["en", "hi"]);
  assert.equal(studio.languages.hindi_ready, true);
  assert.equal(studio.languages.hindi_enabled, true);
  const kyc = studio.stages.find((stage) => stage.key === "KYC_VERIFIED");
  assert.equal(kyc.settings.template_name_hi, hi.name);
  assert.equal(kyc.active_template_hi.name, hi.name);
  assert.equal(kyc.active_template.language, "en");
  assert.equal(kyc.templates.filter((template) => template.language === "hi").length, 1);
  for (const stage of studio.stages) assert.match(stage.default_body_hi, DEVANAGARI, stage.key);
  assert.deepEqual(studio.recent.map((row) => row.language).sort(), ["en", "hi"]);
});

test("a server deployed before migration 246 keeps sending English exactly as before", async (t) => {
  const { pg, db } = await setup(t, { migrate: false });
  const studio = await accountWhatsAppStudio(admin, 1, { db });
  assert.deepEqual(
    [studio.languages.hindi_ready, studio.languages.hindi_enabled],
    [false, false],
  );
  const kyc = studio.stages.find((stage) => stage.key === "KYC_VERIFIED");
  assert.equal(kyc.active_template_hi, null);
  assert.ok(studio.recent.every((row) => !("language" in row)));
  await assert.rejects(
    saveAccountWhatsAppStage(admin, "KYC_VERIFIED", { site_id: 1, template_name_hi: "x" }, { db }),
    /migration 246/,
  );
  await queueAccountWhatsApp("KYC_VERIFIED", 30, { db });
  const { calls, send, upload } = provider(pg);
  await drainAccountWhatsApp({ db, send, upload });
  assert.deepEqual(calls.map((call) => call.language), ["en"]);
});
