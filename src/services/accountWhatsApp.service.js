import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { PLOT_BUYER_MEMBER_JOIN } from "./plotMemberLinks.service.js";
import { registryDeedScopeSql } from "../utils/registryDocuments.js";
import { allocateInstallmentPayments } from "./installmentAllocation.service.js";
import { classifyAccountWhatsAppPayment } from "./accountWhatsAppWorkflow.policy.js";
import {
  ACCOUNT_WHATSAPP_EVENTS as EVENTS,
  ACCOUNT_WHATSAPP_POLICY as POLICY,
  accountWhatsAppError as fail,
  accountWhatsAppCategory,
  accountWhatsAppPhone,
  compileAccountWhatsAppBody,
  cleanAccountWhatsAppParameter,
  isAccountWhatsAppPaymentEligible,
} from "./accountWhatsApp.spec.js";
export {
  ACCOUNT_WHATSAPP_EVENTS,
  ACCOUNT_WHATSAPP_POLICY,
} from "./accountWhatsApp.spec.js";

const configured = () => Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID);
const enabled = () => process.env.WHATSAPP_ENABLED === "true";
const language = () => process.env.WHATSAPP_TEMPLATE_LANG || "en";
const inTest = () => Boolean(process.env.NODE_TEST_CONTEXT);
const assertEvent = (event) => {
  if (!EVENTS[event]) throw fail("Unknown module event", 404);
  return EVENTS[event];
};
const titleFor = (title) => {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 80)
    throw fail("Give the template a title of up to 80 characters");
  return title.trim();
};
const awsError = async (promise) => {
  try {
    return await promise;
  } catch (error) {
    if (error.$metadata)
      throw fail(`WhatsApp (AWS) ${error.name}: ${error.message}`, 422);
    throw error;
  }
};

/** No SDK or network is initialized on import, during hooks, or during default node tests. */
let awsContext;
async function aws() {
  if (inTest()) throw fail("Live WhatsApp transport is disabled in tests", 409);
  if (!configured())
    throw fail("Configure WHATSAPP_PHONE_NUMBER_ID before using WhatsApp", 409);
  if (!awsContext) {
    const sdk = await import("@aws-sdk/client-socialmessaging");
    const client = new sdk.SocialMessagingClient({
      region:
        process.env.WHATSAPP_AWS_REGION ||
        process.env.AWS_REGION ||
        "ap-south-1",
      ...(process.env.WHATSAPP_AWS_ACCESS_KEY_ID
        ? {
            credentials: {
              accessKeyId: process.env.WHATSAPP_AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.WHATSAPP_AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
    awsContext = { sdk, client };
  }
  return awsContext;
}
let senderCache;
async function sender() {
  if (!senderCache || Date.now() - senderCache.at > 600_000) {
    const { sdk, client } = await aws();
    const out = await awsError(
      client.send(
        new sdk.GetLinkedWhatsAppBusinessAccountPhoneNumberCommand({
          id: process.env.WHATSAPP_PHONE_NUMBER_ID,
        }),
      ),
    );
    senderCache = {
      at: Date.now(),
      wabaId: out.linkedWhatsAppBusinessAccountId,
      number: out.phoneNumber?.displayPhoneNumber,
      name: out.phoneNumber?.displayPhoneNumberName,
      quality: out.phoneNumber?.qualityRating,
    };
  }
  return senderCache;
}
export async function sendAccountWhatsAppTemplate(
  to,
  template,
  params = [],
  { language: code = language(), ref } = {},
) {
  const { sdk, client } = await aws();
  const message = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: template,
      language: { code },
      ...(params.length
        ? {
            components: [
              {
                type: "body",
                parameters: params.map((text) => ({ type: "text", text })),
              },
            ],
          }
        : {}),
    },
    ...(ref ? { biz_opaque_callback_data: ref } : {}),
  };
  const out = await awsError(
    client.send(
      new sdk.SendWhatsAppMessageCommand({
        originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        metaApiVersion: process.env.WHATSAPP_META_API_VERSION || "v23.0",
        message: Buffer.from(JSON.stringify(message)),
      }),
    ),
  );
  return out.messageId;
}
const remoteTransport = {
  sender,
  async create(definition) {
    const { sdk, client } = await aws();
    const { wabaId } = await sender();
    return awsError(
      client.send(
        new sdk.CreateWhatsAppMessageTemplateCommand({
          id: wabaId,
          templateDefinition: Buffer.from(JSON.stringify(definition)),
        }),
      ),
    );
  },
  async remove(name) {
    const { sdk, client } = await aws();
    const { wabaId } = await sender();
    return awsError(
      client.send(
        new sdk.DeleteWhatsAppMessageTemplateCommand({
          id: wabaId,
          templateName: name,
          deleteAllLanguages: true,
        }),
      ),
    );
  },
  async list() {
    const { sdk, client } = await aws();
    const { wabaId } = await sender();
    const templates = [];
    let nextToken;
    do {
      const page = await awsError(
        client.send(
          new sdk.ListWhatsAppMessageTemplatesCommand({
            id: wabaId,
            nextToken,
            maxResults: 100,
          }),
        ),
      );
      templates.push(...(page.templates || []));
      nextToken = page.nextToken;
    } while (nextToken);
    return templates;
  },
  async rejection(metaId) {
    if (!metaId) return null;
    const { sdk, client } = await aws();
    const { wabaId } = await sender();
    const out = await awsError(
      client.send(
        new sdk.GetWhatsAppMessageTemplateCommand({
          id: wabaId,
          metaTemplateId: metaId,
        }),
      ),
    );
    try {
      return JSON.parse(out.template).rejected_reason || null;
    } catch {
      return null;
    }
  },
};

export async function assertAccountWhatsAppSite(user, siteId, db = pool) {
  if (!["admin", "super_admin"].includes(user?.role))
    throw fail("Only administrators manage WhatsApp Studio", 403);
  const id = Number(siteId);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw fail("Choose a project to manage WhatsApp");
  const result = await db.query(
    "SELECT id, name FROM sites WHERE id=$1 AND organization_id=$2",
    [id, user.organization_id],
  );
  if (!result.rows[0])
    throw fail("Project not found or unavailable to your account", 403);
  return id;
}
export async function accountWhatsAppSchemaReady(db = pool) {
  if (inTest() && db === pool) return false;
  const {
    rows: [row],
  } = await db.query(
    "SELECT to_regclass('public.account_whatsapp_templates') IS NOT NULL AND to_regclass('public.account_whatsapp_stage_settings') IS NOT NULL AND to_regclass('public.account_whatsapp_messages') IS NOT NULL AS ready",
  );
  return Boolean(row?.ready);
}
async function requireSchema(db) {
  if (!(await accountWhatsAppSchemaReady(db)))
    throw fail(
      "WhatsApp Studio needs migration 225_account_whatsapp_studio. No messages have been enabled.",
      503,
    );
}
async function transaction(db, siteId, action) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // All lifecycle writes in one site serialize, avoiding apply/archive/delete races.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('account_whatsapp_site:' || $1::text))",
      [siteId],
    );
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function stageSettings(siteId, event, db) {
  return (
    (
      await db.query(
        "SELECT * FROM account_whatsapp_stage_settings WHERE site_id=$1 AND event=$2",
        [siteId, event],
      )
    ).rows[0] || {
      site_id: siteId,
      event,
      enabled: false,
      template_name: null,
      lead_days: 3,
      enabled_at: null,
    }
  );
}
async function activeTemplate(siteId, event, db) {
  return (
    (
      await db.query(
        `SELECT t.* FROM account_whatsapp_templates t JOIN account_whatsapp_stage_settings s ON s.site_id=t.site_id AND s.event=t.event AND s.template_name=t.name
    WHERE s.site_id=$1 AND s.event=$2 AND t.status='APPROVED' AND t.archived_at IS NULL`,
        [siteId, event],
      )
    ).rows[0] || null
  );
}
export async function refreshAccountWhatsAppTemplates(
  db = pool,
  transport = remoteTransport,
  siteId = null,
) {
  if (inTest() && transport === remoteTransport) return;
  const remote = new Map(
    (await transport.list()).map((t) => [t.templateName, t]),
  );
  const { rows } = await db.query(
    "SELECT id,name,status,rejected_reason FROM account_whatsapp_templates WHERE meta_template_id IS NOT NULL AND status <> 'DELETED' AND ($1::integer IS NULL OR site_id=$1)",
    [siteId],
  );
  for (const row of rows) {
    const found = remote.get(row.name);
    if (!found) {
      // A template deleted externally must never remain locally APPROVED.
      await db.query(
        "UPDATE account_whatsapp_templates SET status='MISSING',updated_at=now() WHERE id=$1",
        [row.id],
      );
      continue;
    }
    let reason = null;
    if (found.templateStatus === "REJECTED")
      reason =
        row.rejected_reason ||
        (await transport.rejection(found.metaTemplateId).catch(() => null));
    await db.query(
      "UPDATE account_whatsapp_templates SET status=$2,category=$3,rejected_reason=$4,meta_template_id=$5,updated_at=now() WHERE id=$1",
      [
        row.id,
        found.templateStatus || "PENDING",
        found.templateCategory || "UTILITY",
        reason,
        found.metaTemplateId || null,
      ],
    );
  }
}
export async function accountWhatsAppStudio(
  user,
  requestedSiteId,
  { db = pool, transport = remoteTransport } = {},
) {
  const siteId = await assertAccountWhatsAppSite(user, requestedSiteId, db);
  const ready = await accountWhatsAppSchemaReady(db);
  let info = null;
  let error = ready
    ? null
    : "Run migration 225_account_whatsapp_studio to activate this workspace. All automations start off.";
  if (ready && configured() && !inTest()) {
    try {
      await refreshAccountWhatsAppTemplates(db, transport, siteId);
      info = await transport.sender();
    } catch (e) {
      error = e.message;
    }
  }
  const templates = ready
    ? (
        await db.query(
          "SELECT * FROM account_whatsapp_templates WHERE site_id=$1 AND status <> 'DELETED' ORDER BY created_at DESC,id DESC",
          [siteId],
        )
      ).rows
    : [];
  const settings = ready
    ? (
        await db.query(
          "SELECT * FROM account_whatsapp_stage_settings WHERE site_id=$1",
          [siteId],
        )
      ).rows
    : [];
  const recent = ready
    ? (
        await db.query(
          "SELECT id,event,ref_id,status,phone,template,error,is_test,created_at,updated_at FROM account_whatsapp_messages WHERE site_id=$1 ORDER BY id DESC LIMIT 100",
          [siteId],
        )
      ).rows
    : [];
  return {
    site_id: siteId,
    enabled: enabled(),
    configured: configured(),
    schema_ready: ready,
    error,
    policy: POLICY,
    sender: info && {
      number: info.number,
      name: info.name,
      quality: info.quality,
    },
    templates,
    stages: Object.entries(EVENTS).map(([key, spec]) => {
      const saved = settings.find((s) => s.event === key) || {
        event: key,
        enabled: false,
        template_name: null,
        lead_days: 3,
      };
      const own = templates.filter((t) => t.event === key);
      return {
        key,
        label: spec.label,
        module: spec.module,
        submodule: spec.submodule,
        trigger: spec.trigger,
        description: spec.description,
        default_body: spec.body,
        fields: Object.entries(spec.fields).map(([name, f]) => ({
          name,
          label: f.label,
          sample: f.sample,
        })),
        documents: [],
        settings: saved,
        active_template:
          own.find(
            (t) =>
              t.name === saved.template_name &&
              t.status === "APPROVED" &&
              !t.archived_at,
          ) || null,
        templates: own,
      };
    }),
    recent,
  };
}
export async function saveAccountWhatsAppStage(
  user,
  event,
  input,
  { db = pool } = {},
) {
  assertEvent(event);
  const siteId = await assertAccountWhatsAppSite(user, input.site_id, db);
  await requireSchema(db);
  if (input.enabled !== undefined && typeof input.enabled !== "boolean")
    throw fail("enabled must be true or false");
  if (
    input.template_name !== undefined &&
    input.template_name !== null &&
    (typeof input.template_name !== "string" || !input.template_name.trim())
  )
    throw fail("Choose a template or null to unapply it");
  if (
    input.lead_days !== undefined &&
    (event !== "INSTALLMENT_DUE" ||
      !Number.isInteger(input.lead_days) ||
      input.lead_days < 0 ||
      input.lead_days > 30)
  )
    throw fail("Reminder lead time must be an integer between 0 and 30 days");
  return transaction(db, siteId, async (client) => {
    await client.query(
      "INSERT INTO account_whatsapp_stage_settings(site_id,event) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [siteId, event],
    );
    const previous = await stageSettings(siteId, event, client);
    const name =
      input.template_name === undefined
        ? previous.template_name
        : input.template_name;
    const nextEnabled =
      input.enabled ??
      (input.template_name === null ? false : previous.enabled);
    if (name) {
      const template = (
        await client.query(
          "SELECT * FROM account_whatsapp_templates WHERE site_id=$1 AND name=$2 FOR UPDATE",
          [siteId, name],
        )
      ).rows[0];
      if (
        !template ||
        template.event !== event ||
        template.status !== "APPROVED" ||
        template.archived_at
      )
        throw fail(
          "Apply an approved, unarchived template created for this module",
          409,
        );
    }
    if (nextEnabled && !name)
      throw fail(
        "Apply an approved template before enabling this automation",
        409,
      );
    return (
      await client.query(
        `UPDATE account_whatsapp_stage_settings SET enabled=$3,template_name=$4,lead_days=$5,
      enabled_at=CASE WHEN $3 AND NOT enabled THEN now() ELSE enabled_at END,updated_by=$6,updated_at=now()
      WHERE site_id=$1 AND event=$2 RETURNING *`,
        [
          siteId,
          event,
          nextEnabled,
          name,
          input.lead_days ?? previous.lead_days,
          user.id,
        ],
      )
    ).rows[0];
  });
}
export async function createAccountWhatsAppTemplate(
  user,
  input,
  { db = pool, transport = remoteTransport } = {},
) {
  assertEvent(input.event);
  const siteId = await assertAccountWhatsAppSite(user, input.site_id, db);
  await requireSchema(db);
  const title = titleFor(input.title);
  const category = accountWhatsAppCategory(input.category);
  const compiled = compileAccountWhatsAppBody(input.event, input.body);
  const name = `dgg_acc_s${siteId}_${input.event.toLowerCase()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // Save a draft first: provider or connection failures never lose the edited text.
  let template = (
    await db.query(
      `INSERT INTO account_whatsapp_templates(site_id,event,name,title,body,fields,language,status,created_by,category)
    VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9) RETURNING *`,
      [
        siteId,
        input.event,
        name,
        title,
        compiled.body,
        compiled.fields,
        language(),
        user.id,
        category,
      ],
    )
  ).rows[0];
  if (!configured() && transport === remoteTransport)
    return {
      ...template,
      notice:
        "Saved as draft. Configure the WhatsApp sender, then submit a new version for approval.",
    };
  try {
    const created = await transport.create({
      name,
      language: template.language,
      category,
      allow_category_change: true,
      parameter_format: "positional",
      components: [
        {
          type: "BODY",
          text: compiled.text,
          ...(compiled.fields.length
            ? {
                example: {
                  body_text: [
                    compiled.fields.map(
                      (key) => EVENTS[input.event].fields[key].sample,
                    ),
                  ],
                },
              }
            : {}),
        },
      ],
    });
    const status = created.templateStatus || "PENDING";
    const reason =
      status === "REJECTED"
        ? await transport.rejection(created.metaTemplateId).catch(() => null)
        : null;
    template = (
      await db.query(
        "UPDATE account_whatsapp_templates SET status=$2,category=$3,meta_template_id=$4,rejected_reason=$5,updated_at=now() WHERE id=$1 RETURNING *",
        [
          template.id,
          status,
          created.category || category,
          created.metaTemplateId || null,
          reason,
        ],
      )
    ).rows[0];
    return template;
  } catch (error) {
    await db.query(
      "UPDATE account_whatsapp_templates SET status='SUBMISSION_FAILED',rejected_reason=$2,updated_at=now() WHERE id=$1",
      [template.id, String(error.message).slice(0, 500)],
    );
    throw fail(
      `Draft saved, but approval submission failed: ${error.message}`,
      error.status || 422,
    );
  }
}
async function assertUnused(template, db) {
  if (
    (
      await db.query(
        "SELECT 1 FROM account_whatsapp_stage_settings WHERE site_id=$1 AND template_name=$2",
        [template.site_id, template.name],
      )
    ).rows.length
  )
    throw fail(
      "Unapply this template from its module before archiving or deleting it",
      409,
    );
  if (
    (
      await db.query(
        "SELECT 1 FROM account_whatsapp_messages WHERE site_id=$1 AND event=$2 AND status='SENDING' LIMIT 1",
        [template.site_id, template.event],
      )
    ).rows.length
  )
    throw fail(
      "A message for this module is sending. Wait for it to finish before changing this template",
      409,
    );
}
export async function updateAccountWhatsAppTemplate(
  user,
  name,
  input,
  { db = pool } = {},
) {
  const siteId = await assertAccountWhatsAppSite(user, input.site_id, db);
  await requireSchema(db);
  if (input.archived !== undefined && typeof input.archived !== "boolean")
    throw fail("archived must be true or false");
  const title = input.title === undefined ? undefined : titleFor(input.title);
  if (title === undefined && input.archived === undefined)
    throw fail("Provide a title or archive status");
  return transaction(db, siteId, async (client) => {
    const row = (
      await client.query(
        "SELECT * FROM account_whatsapp_templates WHERE site_id=$1 AND name=$2 AND status <> 'DELETED' FOR UPDATE",
        [siteId, name],
      )
    ).rows[0];
    if (!row) throw fail("Template not found", 404);
    if (input.archived === true) await assertUnused(row, client);
    return (
      await client.query(
        `UPDATE account_whatsapp_templates SET title=$2,archived_at=CASE WHEN $3::boolean THEN COALESCE(archived_at,now()) ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          row.id,
          title ?? row.title,
          input.archived ?? Boolean(row.archived_at),
        ],
      )
    ).rows[0];
  });
}
export async function deleteAccountWhatsAppTemplate(
  user,
  name,
  requestedSiteId,
  { db = pool, transport = remoteTransport } = {},
) {
  const siteId = await assertAccountWhatsAppSite(user, requestedSiteId, db);
  await requireSchema(db);
  return transaction(db, siteId, async (client) => {
    const row = (
      await client.query(
        "SELECT * FROM account_whatsapp_templates WHERE site_id=$1 AND name=$2 AND status <> 'DELETED' FOR UPDATE",
        [siteId, name],
      )
    ).rows[0];
    if (!row) throw fail("Template not found", 404);
    await assertUnused(row, client);
    if (row.meta_template_id)
      await transport.remove(name).catch((error) => {
        if (!/ResourceNotFound/.test(`${error.name}: ${error.message}`))
          throw error;
      });
    await client.query(
      "UPDATE account_whatsapp_templates SET status='DELETED',updated_at=now() WHERE id=$1",
      [row.id],
    );
    return { deleted: name };
  });
}
export async function previewAccountWhatsAppTemplate(
  user,
  input,
  { db = pool } = {},
) {
  await assertAccountWhatsAppSite(user, input.site_id, db);
  return compileAccountWhatsAppBody(input.event, input.body);
}
export async function testAccountWhatsAppTemplate(
  user,
  input,
  { db = pool, send = sendAccountWhatsAppTemplate } = {},
) {
  assertEvent(input.event);
  const siteId = await assertAccountWhatsAppSite(user, input.site_id, db);
  await requireSchema(db);
  const to = accountWhatsAppPhone(input.phone);
  if (!to) throw fail("Enter a valid 10-digit Indian mobile number");
  if (!enabled() && send === sendAccountWhatsAppTemplate)
    throw fail(
      "The WhatsApp sender is switched off in server configuration",
      409,
    );
  const { template, row } = await transaction(db, siteId, async (client) => {
    const selected = await activeTemplate(siteId, input.event, client);
    if (!selected)
      throw fail("Apply an approved template before sending a sample", 409);
    const claimed = (
      await client.query(
        "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key,is_test,status,phone,template) VALUES($1,$2,0,$3,true,'SENDING',$4,$5) RETURNING *",
        [siteId, input.event, `test:${randomUUID()}`, to, selected.name],
      )
    ).rows[0];
    return { template: selected, row: claimed };
  });
  let messageId;
  try {
    messageId = await send(
      to,
      template.name,
      template.fields.map((key) =>
        cleanAccountWhatsAppParameter(EVENTS[input.event].fields[key]?.sample),
      ),
      { language: template.language, ref: `account-wa-test:${row.id}` },
    );
  } catch (error) {
    await db.query(
      "UPDATE account_whatsapp_messages SET status='FAILED',error=$2,updated_at=now() WHERE id=$1",
      [row.id, String(error.message).slice(0, 500)],
    );
    throw error;
  }
  await db
    .query(
      "UPDATE account_whatsapp_messages SET status='SENT',provider_message_id=$2,updated_at=now() WHERE id=$1",
      [row.id, messageId],
    )
    .catch((error) =>
      console.error(
        "[account-whatsapp] sample accepted but log update failed:",
        error.message,
      ),
    );
  return {
    to,
    template: template.name,
    message_id: messageId,
    sample_only: true,
  };
}

const MEMBER_COLUMNS = `m.full_name,m.phone,m.whatsapp,COALESCE(to_jsonb(m)->>'member_code','CLT-' || m.id::text) AS member_code,s.name AS site_name`;
const PLOT_COLUMNS = `plot_buyer.full_name,plot_buyer.phone,plot_buyer.whatsapp,COALESCE(to_jsonb(plot_buyer)->>'member_code','CLT-' || plot_buyer.id::text) AS member_code,p.plot_no,p.site_id,s.name AS site_name`;
const CLIENT_PREDICATE = `'CLIENT'=ANY(COALESCE(m.member_types,ARRAY[m.member_type])) AND UPPER(COALESCE(to_jsonb(m)->>'status','ACTIVE'))='ACTIVE'`;
const PLOT_CLIENT_PREDICATE = `'CLIENT'=ANY(COALESCE(plot_buyer.member_types,ARRAY[plot_buyer.member_type])) AND UPPER(COALESCE(to_jsonb(plot_buyer)->>'status','ACTIVE'))='ACTIVE'`;
const ACTIVE_INSTALLMENT_PLOT = `UPPER(TRIM(p.status)) IN ('BOOKED','REGISTRY') AND LOWER(COALESCE(to_jsonb(p)->>'approval_status',''))='approved' AND UPPER(COALESCE(to_jsonb(p)->>'plot_tag','')) <> 'OLD'`;
/** Re-read canonical records at delivery. Hooks never supply phone numbers, amounts or template parameters. */
export async function loadAccountWhatsAppContext(
  event,
  refId,
  siteId,
  db = pool,
) {
  let query;
  if (event === "CLIENT_ONBOARDED")
    query = `SELECT ${MEMBER_COLUMNS},m.site_id FROM members m JOIN sites s ON s.id=m.site_id WHERE m.id=$1 AND m.site_id=$2 AND ${CLIENT_PREDICATE}`;
  else if (event === "KYC_VERIFIED")
    query = `SELECT ${MEMBER_COLUMNS},k.site_id FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id JOIN sites s ON s.id=k.site_id WHERE k.id=$1 AND k.site_id=$2 AND k.status='VERIFIED' AND ${CLIENT_PREDICATE}`;
  else if (event === "PLOT_BOOKED")
    query = `SELECT ${PLOT_COLUMNS} FROM plots p JOIN sites s ON s.id=p.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE p.id=$1 AND p.site_id=$2 AND UPPER(p.status)='BOOKED' AND LOWER(COALESCE(to_jsonb(p)->>'approval_status',''))='approved' AND ${PLOT_CLIENT_PREDICATE}`;
  else if (["PAYMENT_RECEIVED", "PAYMENT_SENT"].includes(event))
    query = `SELECT ${PLOT_COLUMNS},pp.amount,pp.payment_type,pp.payment_type AS payment_mode,pp.payment_from,to_jsonb(pp)->>'money_transfer_id' AS money_transfer_id,to_jsonb(pp)->>'money_transfer_role' AS money_transfer_role,to_jsonb(pp)->>'entry_transfer_id' AS entry_transfer_id,pp.date AS payment_date,'RG-' || pp.id::text AS receipt_no,pp.status,pp.cheque_status FROM plot_payments pp JOIN plots p ON p.id=pp.plot_id AND p.site_id=pp.site_id JOIN sites s ON s.id=p.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE pp.id=$1 AND p.site_id=$2 AND ${PLOT_CLIENT_PREDICATE}`;
  else if (event === "INSTALLMENT_RECEIVED")
    query = `SELECT ${PLOT_COLUMNS},pip.amount,pip.payment_mode,pip.payment_date,'INS-' || pip.id::text AS receipt_no,pip.status,pip.cheque_status,to_jsonb(pip)->>'entry_transfer_id' AS entry_transfer_id,pi.installment_name FROM plot_installment_payments pip JOIN plots p ON p.id=pip.plot_id JOIN sites s ON s.id=p.site_id LEFT JOIN plot_installments pi ON pi.id=pip.installment_id AND pi.plot_id=p.id ${PLOT_BUYER_MEMBER_JOIN} WHERE pip.id=$1 AND p.site_id=$2 AND ${PLOT_CLIENT_PREDICATE}`;
  else if (event === "INSTALLMENT_DUE")
    query = `SELECT ${PLOT_COLUMNS},pi.id AS installment_id,p.id AS plot_id,pi.installment_name,pi.amount,pi.due_date FROM plot_installments pi JOIN plots p ON p.id=pi.plot_id AND p.installments_enabled JOIN sites s ON s.id=p.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE pi.id=$1 AND p.site_id=$2 AND ${ACTIVE_INSTALLMENT_PLOT} AND ${PLOT_CLIENT_PREDICATE}`;
  else if (event === "REGISTRY_COMPLETED")
    query = `SELECT ${PLOT_COLUMNS},pr.registry_date FROM plot_registries pr JOIN LATERAL (SELECT source.* FROM plots source WHERE source.site_id=pr.site_id AND (source.id=pr.plot_id OR (pr.plot_id IS NULL AND UPPER(source.plot_no)=UPPER(to_jsonb(pr)->>'plot_no') AND UPPER(COALESCE(to_jsonb(source)->>'plot_tag','')) <> 'OLD' AND (SELECT COUNT(*) FROM plots candidate WHERE candidate.site_id=pr.site_id AND UPPER(candidate.plot_no)=UPPER(to_jsonb(pr)->>'plot_no') AND UPPER(COALESCE(to_jsonb(candidate)->>'plot_tag','')) <> 'OLD')=1)) ORDER BY source.id DESC LIMIT 1) p ON TRUE JOIN sites s ON s.id=p.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE pr.id=$1 AND pr.site_id=$2 AND pr.registry_date IS NOT NULL AND EXISTS(SELECT 1 FROM registry_document_handovers h WHERE h.registry_id=pr.id) AND EXISTS(SELECT 1 FROM documents d WHERE ${registryDeedScopeSql("p.id")}) AND ${PLOT_CLIENT_PREDICATE}`;
  else return null;
  const data = (await db.query(query, [refId, siteId])).rows[0];
  if (!data) return null;
  if (
    ["PAYMENT_RECEIVED", "PAYMENT_SENT", "INSTALLMENT_RECEIVED"].includes(
      event,
    ) &&
    (!isAccountWhatsAppPaymentEligible(data, event) ||
      !classifyAccountWhatsAppPayment(event, data) ||
      data.money_transfer_id ||
      data.money_transfer_role)
  )
    return null;
  if (event === "INSTALLMENT_DUE") {
    const [{ rows: installments }, { rows: generic }, { rows: direct }] =
      await Promise.all([
        db.query(
          "SELECT id,amount,due_date,sort_order FROM plot_installments WHERE plot_id=$1 ORDER BY sort_order,due_date,id",
          [data.plot_id],
        ),
        db.query(
          "SELECT COALESCE(SUM(amount),0) AS total FROM plot_payments WHERE plot_id=$1 AND financial_transaction_posts('credit',status,payment_type,cheque_status)",
          [data.plot_id],
        ),
        db.query(
          "SELECT installment_id,COALESCE(SUM(amount),0) AS total FROM plot_installment_payments WHERE plot_id=$1 AND financial_transaction_posts('credit',status,payment_mode,cheque_status) GROUP BY installment_id",
          [data.plot_id],
        ),
      ]);
    // All posted payments, including cash, reduce balances; cash transaction details are never sent.
    const allocation = allocateInstallmentPayments(installments, {
      genericPaid: Number(generic[0]?.total) || 0,
      directPaidByInstallment: Object.fromEntries(
        direct.map((r) => [r.installment_id, Number(r.total)]),
      ),
    });
    data.remaining =
      allocation.installments.find(
        (r) => Number(r.id) === Number(data.installment_id),
      )?.remaining || 0;
    if (data.remaining <= 0.005) return null;
  }
  return data;
}

/** Post-commit, fail-open hook. No provider calls and no backfill; disabled/unapplied stages drop events. */
export async function queueAccountWhatsApp(event, refId, options = {}) {
  const db = options.db || pool;
  if (
    (inTest() && db === pool) ||
    (!enabled() && db === pool) ||
    !EVENTS[event]
  )
    return { queued: false, reason: "disabled" };
  const reference = Number(refId);
  if (!Number.isSafeInteger(reference) || reference <= 0)
    return { queued: false, reason: "invalid_reference" };
  let client;
  try {
    if (!(await accountWhatsAppSchemaReady(db)))
      return { queued: false, reason: "migration_required" };
    // A lease becomes a SAVEPOINT inside documented financial requests. Rollback
    // isolates optional notification failures from the user's financial write.
    client = await db.connect();
    await client.query("BEGIN");
    let siteId = Number(options.siteId ?? options.site_id);
    if (!Number.isSafeInteger(siteId) || siteId <= 0) {
      const sources = {
        CLIENT_ONBOARDED: "SELECT site_id FROM members WHERE id=$1",
        KYC_VERIFIED: "SELECT site_id FROM kyc_cases WHERE id=$1",
        PLOT_BOOKED: "SELECT site_id FROM plots WHERE id=$1",
        PAYMENT_RECEIVED: "SELECT site_id FROM plot_payments WHERE id=$1",
        PAYMENT_SENT: "SELECT site_id FROM plot_payments WHERE id=$1",
        INSTALLMENT_RECEIVED:
          "SELECT p.site_id FROM plot_installment_payments pip JOIN plots p ON p.id=pip.plot_id WHERE pip.id=$1",
        INSTALLMENT_DUE:
          "SELECT p.site_id FROM plot_installments pi JOIN plots p ON p.id=pi.plot_id WHERE pi.id=$1",
        REGISTRY_COMPLETED: "SELECT site_id FROM plot_registries WHERE id=$1",
      };
      siteId = Number(
        (await client.query(sources[event], [reference])).rows[0]?.site_id,
      );
    }
    let result = { queued: false, reason: "invalid_reference" };
    if (Number.isSafeInteger(siteId) && siteId > 0) {
      const settings = await stageSettings(siteId, event, client);
      result = { queued: false, reason: "stage_disabled" };
      if (settings.enabled && settings.template_name) {
        if (
          !(await loadAccountWhatsAppContext(event, reference, siteId, client))
        )
          result = { queued: false, reason: "policy_or_missing_record" };
        else {
          const key = options.dedupeKey || `${event}:${reference}`;
          const out = await client.query(
            "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT(site_id,dedupe_key) DO NOTHING RETURNING id",
            [siteId, event, reference, key],
          );
          result = {
            queued: Boolean(out.rows[0]),
            id: out.rows[0]?.id,
            reason: out.rows[0] ? undefined : "duplicate",
          };
        }
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("[account-whatsapp] queue failed:", error.message);
    return { queued: false, reason: "error" };
  } finally {
    client?.release();
  }
}

/** Future/current-date only, exact lead-time scheduling; never sweep overdue historical installments. */
export async function scheduleAccountWhatsAppReminders({
  db = pool,
  scanLimit = 500,
} = {}) {
  if ((inTest() || !enabled()) && db === pool) return 0;
  if (!(await accountWhatsAppSchemaReady(db))) return 0;
  const limit = Math.max(
    1,
    Math.min(1000, Math.floor(Number(scanLimit) || 500)),
  );
  let cursor = 0;
  let queued = 0;
  // Paid/ineligible installments do not create outbox rows. Advance the cursor
  // through them so an early page of paid clients cannot starve later clients.
  while (true) {
    const { rows } = await db.query(
      `SELECT pi.id,p.site_id,pi.due_date::text FROM plot_installments pi JOIN plots p ON p.id=pi.plot_id AND p.installments_enabled
      JOIN account_whatsapp_stage_settings s ON s.site_id=p.site_id AND s.event='INSTALLMENT_DUE' AND s.enabled AND s.template_name IS NOT NULL
      WHERE ${ACTIVE_INSTALLMENT_PLOT} AND pi.id>$1 AND pi.due_date=(now() AT TIME ZONE 'Asia/Kolkata')::date + s.lead_days
      AND s.enabled_at IS NOT NULL AND pi.due_date >= (s.enabled_at AT TIME ZONE 'Asia/Kolkata')::date
      AND NOT EXISTS(SELECT 1 FROM account_whatsapp_messages w WHERE w.site_id=p.site_id AND w.dedupe_key='INSTALLMENT_DUE:' || pi.id::text || ':' || pi.due_date::text)
      ORDER BY pi.id LIMIT $2`,
      [cursor, limit],
    );
    for (const row of rows) {
      const result = await queueAccountWhatsApp("INSTALLMENT_DUE", row.id, {
        siteId: row.site_id,
        dedupeKey: `INSTALLMENT_DUE:${row.id}:${row.due_date}`,
        db,
      });
      if (result.queued) queued++;
      cursor = Number(row.id);
    }
    if (rows.length < limit) break;
  }
  return queued;
}
export async function deliverAccountWhatsApp(
  row,
  { db = pool, send = sendAccountWhatsAppTemplate } = {},
) {
  let template = null;
  let phone = null;
  let messageId;
  const finish = (status, error = null) =>
    db.query(
      "UPDATE account_whatsapp_messages SET status=$2,phone=$3,template=$4,provider_message_id=$5,error=$6,updated_at=now() WHERE id=$1",
      [
        row.id,
        status,
        phone,
        template?.name || null,
        messageId || null,
        error && String(error).slice(0, 500),
      ],
    );
  if (
    (!enabled() || !configured() || inTest()) &&
    send === sendAccountWhatsAppTemplate
  )
    return finish("SKIPPED", "WhatsApp transport is disabled");
  if (row.is_test)
    return finish(
      "SKIPPED",
      "Sample tests are sent only from the administrator test action",
    );
  try {
    const spec = EVENTS[row.event];
    if (!spec) return finish("SKIPPED", "Unknown event");
    const settings = await stageSettings(row.site_id, row.event, db);
    if (!settings.enabled)
      return finish("SKIPPED", "Automation is switched off in WhatsApp Studio");
    template = await activeTemplate(row.site_id, row.event, db);
    if (!template)
      return finish("SKIPPED", "No approved, unarchived template is applied");
    const data = await loadAccountWhatsAppContext(
      row.event,
      row.ref_id,
      row.site_id,
      db,
    );
    if (!data)
      return finish(
        "SKIPPED",
        "Current record is missing or blocked by payment / completion policy",
      );
    if (row.event === "INSTALLMENT_DUE") {
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const due =
        data.due_date instanceof Date
          ? new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Kolkata",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(data.due_date)
          : String(data.due_date).slice(0, 10);
      if (
        due < today ||
        due !==
          String(row.dedupe_key || "")
            .split(":")
            .at(-1)
      )
        return finish(
          "SKIPPED",
          "Installment due date changed or is now historical",
        );
    }
    phone =
      accountWhatsAppPhone(data.whatsapp) || accountWhatsAppPhone(data.phone);
    if (!phone)
      return finish("SKIPPED", "Client has no valid Indian mobile number");
    if (template.fields.some((key) => !spec.fields[key]))
      return finish("SKIPPED", "Template contains an unsupported field");
    messageId = await send(
      phone,
      template.name,
      template.fields.map((key) =>
        cleanAccountWhatsAppParameter(spec.fields[key].value(data)),
      ),
      { language: template.language, ref: `account-wa:${row.id}` },
    );
  } catch (error) {
    return finish("FAILED", `${error.name}: ${error.message}`).catch(() => {});
  }
  // Never retry an accepted message just because recording its acceptance fails.
  await finish("SENT").catch((error) =>
    console.error(
      "[account-whatsapp] accepted message could not be recorded:",
      error.message,
    ),
  );
}
export async function drainAccountWhatsApp({
  db = pool,
  send = sendAccountWhatsAppTemplate,
  max = 20,
} = {}) {
  if (
    ((inTest() || !enabled() || !configured()) && db === pool) ||
    !(await accountWhatsAppSchemaReady(db))
  )
    return 0;
  await db.query(
    "UPDATE account_whatsapp_messages SET status='FAILED',error='Interrupted during send; verify receipt before manual intervention',updated_at=now() WHERE status='SENDING' AND updated_at < now()-interval '10 minutes'",
  );
  let count = 0;
  for (; count < max; count++) {
    const client = await db.connect();
    let row;
    try {
      await client.query("BEGIN");
      const candidate = (
        await client.query(
          "SELECT id,site_id FROM account_whatsapp_messages WHERE status='QUEUED' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
        )
      ).rows[0];
      if (candidate) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('account_whatsapp_site:' || $1::text))",
          [candidate.site_id],
        );
        row = (
          await client.query(
            "UPDATE account_whatsapp_messages SET status=CASE WHEN created_at < now()-interval '1 day' THEN 'EXPIRED' ELSE 'SENDING' END,updated_at=now() WHERE id=$1 RETURNING *",
            [candidate.id],
          )
        ).rows[0];
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (!row) break;
    if (row.status === "SENDING")
      await deliverAccountWhatsApp(row, { db, send });
  }
  return count;
}
let workerTimer;
let workerStarted = false;
let stopped = false;
export function stopAccountWhatsAppWorker() {
  stopped = true;
  workerStarted = false;
  clearTimeout(workerTimer);
}
export function startAccountWhatsAppWorker(intervalMs = 10_000) {
  if (workerStarted || inTest() || !enabled() || !configured()) return;
  stopped = false;
  workerStarted = true;
  let lastRefresh = 0;
  let lastSchedule = 0;
  let warnedSchema = false;
  const tick = async () => {
    if (stopped) return;
    try {
      if (!(await accountWhatsAppSchemaReady())) {
        if (!warnedSchema)
          console.warn(
            "[account-whatsapp] Migration 225 is required; worker remains idle",
          );
        warnedSchema = true;
        return;
      }
      warnedSchema = false;
      if (Date.now() - lastRefresh > 600_000) {
        await refreshAccountWhatsAppTemplates();
        lastRefresh = Date.now();
      }
      if (Date.now() - lastSchedule > 60_000) {
        await scheduleAccountWhatsAppReminders();
        lastSchedule = Date.now();
      }
      await drainAccountWhatsApp();
    } catch (error) {
      console.error("[account-whatsapp] worker:", error.message);
    } finally {
      if (!stopped) {
        workerTimer = setTimeout(tick, intervalMs);
        workerTimer.unref();
      }
    }
  };
  void tick();
}
