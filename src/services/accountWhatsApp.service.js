import { randomUUID } from "node:crypto";
import pool from "../config/db.js";
import { PLOT_BUYER_MEMBER_JOIN } from "./plotMemberLinks.service.js";
import { registryDeedScopeSql } from "../utils/registryDocuments.js";
import { allocateInstallmentPayments } from "./installmentAllocation.service.js";
import { classifyAccountWhatsAppPayment } from "./accountWhatsAppWorkflow.policy.js";
import { getReceiptDesign } from "./receiptDesign.service.js";
import {
  ACCOUNT_WHATSAPP_DOCUMENT_EVENTS,
  accountWhatsAppReceiptSample,
  accountWhatsAppReceiptFilename,
  renderAccountWhatsAppReceipt,
} from "./accountWhatsAppDocuments.js";
import {
  accountWhatsAppProviderName,
  accountWhatsAppTemplateView,
  isImportedAccountWhatsAppTemplate,
  inspectAccountWhatsAppRemoteTemplate,
  mapAccountWhatsAppRemoteBody,
  accountTemplateStatesPendingKyc,
  assertAccountWhatsAppImportedDefinition,
} from "./accountWhatsAppImport.spec.js";
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
const requiresPaymentReceipt = (event) =>
  ACCOUNT_WHATSAPP_DOCUMENT_EVENTS.includes(event);
const assertPaymentReceiptTemplate = (event, template) => {
  if (requiresPaymentReceipt(event) && !template?.has_document)
    throw fail(
      "Payment messages require a PDF document-header template. Import an approved PDF template or create a new version with its receipt attachment before enabling this automation.",
      409,
    );
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
  { language: code = language(), ref, media } = {},
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
      ...(params.length || media
        ? {
            components: [
              ...(media
                ? [
                    {
                      type: "header",
                      parameters: [
                        {
                          type: "document",
                          document: { id: media.id, filename: media.filename },
                        },
                      ],
                    },
                  ]
                : []),
              ...(params.length
                ? [
                    {
                      type: "body",
                      parameters: params.map((text) => ({
                        type: "text",
                        text,
                      })),
                    },
                  ]
                : []),
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
let mediaStorage;
async function storeAccountWhatsAppDocument(buffer, filename) {
  const bucketName = process.env.WHATSAPP_MEDIA_BUCKET;
  if (!bucketName)
    throw fail(
      "Configure WHATSAPP_MEDIA_BUCKET before sending receipt PDFs",
      409,
    );
  await aws();
  if (!mediaStorage) {
    const { S3Client } = await import("@aws-sdk/client-s3");
    mediaStorage = new S3Client({
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
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const key = `whatsapp/accountancy/${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${filename}`;
  await awsError(
    mediaStorage.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: buffer,
        ContentType: "application/pdf",
      }),
    ),
  );
  return { bucketName, key };
}
export async function uploadAccountWhatsAppDocument(buffer, filename) {
  const sourceS3File = await storeAccountWhatsAppDocument(buffer, filename);
  const { sdk, client } = await aws();
  const result = await awsError(
    client.send(
      new sdk.PostWhatsAppMessageMediaCommand({
        originationPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
        sourceS3File,
      }),
    ),
  );
  if (!result.mediaId)
    throw fail("AWS did not return the receipt media ID", 502);
  return result.mediaId;
}
export async function uploadAccountWhatsAppTemplateDocument(
  buffer,
  filename,
  { store = storeAccountWhatsAppDocument, context = aws, senderDetails = sender } = {},
) {
  // Approval uploads return a Meta header handle; delivery uploads return a media ID.
  const sourceS3File = await store(buffer, filename);
  const { sdk, client } = await context();
  const { wabaId } = await senderDetails();
  const result = await awsError(client.send(
    new sdk.CreateWhatsAppMessageTemplateMediaCommand({ id: wabaId, sourceS3File }),
  ));
  if (!result.metaHeaderHandle)
    throw fail("AWS did not return the sample receipt header handle", 502);
  return result.metaHeaderHandle;
}
async function receiptMedia(event, data, upload, { sample = false, db = pool } = {}) {
  const filename = accountWhatsAppReceiptFilename(data);
  const design = await getReceiptDesign(data.site_id, db);
  return {
    type: "document",
    filename,
    id: await upload(
      await renderAccountWhatsAppReceipt(event, data, { sample, design }),
      filename,
    ),
  };
}
async function receiptSampleForSite(event, siteId, db) {
  const site = (await db.query(
    "SELECT name,concat_ws(', ',NULLIF(to_jsonb(s)->>'address',''),NULLIF(to_jsonb(s)->>'city',''),NULLIF(to_jsonb(s)->>'state','')) AS address FROM sites s WHERE id=$1",
    [siteId],
  )).rows[0];
  return {
    ...accountWhatsAppReceiptSample(event),
    site_id: siteId,
    site_name: site?.name || "Sample project",
    site_address: site?.address || "",
  };
}
export async function previewAccountWhatsAppReceipt(
  user,
  requestedSiteId,
  event,
  { db = pool } = {},
) {
  const siteId = await assertAccountWhatsAppSite(user, requestedSiteId, db);
  return renderAccountWhatsAppReceipt(
    event,
    await receiptSampleForSite(event, siteId, db),
    { sample: true, design: await getReceiptDesign(siteId, db) },
  );
}
const remoteTransport = {
  sender,
  uploadTemplateMedia: uploadAccountWhatsAppTemplateDocument,
  async get(metaId) {
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
    return JSON.parse(out.template);
  },
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
    "SELECT to_regclass('public.account_whatsapp_templates') IS NOT NULL AND to_regclass('public.account_whatsapp_stage_settings') IS NOT NULL AND to_regclass('public.account_whatsapp_messages') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='account_whatsapp_templates' AND column_name='has_document') AS ready",
  );
  return Boolean(row?.ready);
}
async function requireSchema(db) {
  if (!(await accountWhatsAppSchemaReady(db)))
    throw fail(
      "WhatsApp Studio needs migrations 225_account_whatsapp_studio and 226_account_whatsapp_documents. No messages have been enabled.",
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
    (await transport.list()).map((t) => [String(t.metaTemplateId), t]),
  );
  const { rows } = await db.query(
    "SELECT * FROM account_whatsapp_templates WHERE meta_template_id IS NOT NULL AND status <> 'DELETED' AND ($1::integer IS NULL OR site_id=$1)",
    [siteId],
  );
  const importedDetails = new Map();
  for (const row of rows) {
    const found = remote.get(String(row.meta_template_id));
    if (!found) {
      // A template deleted externally must never remain locally APPROVED.
      await db.query(
        "UPDATE account_whatsapp_templates SET status='MISSING',updated_at=now() WHERE id=$1",
        [row.id],
      );
      continue;
    }
    let reason = null;
    let status = found.templateStatus || "PENDING";
    if (isImportedAccountWhatsAppTemplate(row) && status === "APPROVED") {
      if (!importedDetails.has(found.metaTemplateId))
        importedDetails.set(
          found.metaTemplateId,
          await transport.get(found.metaTemplateId),
        );
      try {
        assertAccountWhatsAppImportedDefinition(
          row,
          importedDetails.get(found.metaTemplateId),
        );
      } catch (error) {
        status = "CHANGED";
        reason = error.message;
      }
    }
    if (found.templateStatus === "REJECTED")
      reason =
        row.rejected_reason ||
        (await transport.rejection(found.metaTemplateId).catch(() => null));
    await db.query(
      "UPDATE account_whatsapp_templates SET status=$2,category=$3,rejected_reason=$4,meta_template_id=$5,updated_at=now() WHERE id=$1",
      [
        row.id,
        status,
        status === "CHANGED"
          ? row.category
          : found.templateCategory || "UTILITY",
        reason,
        found.metaTemplateId || null,
      ],
    );
  }
}
export async function listAccountWhatsAppRemoteTemplates(
  user,
  requestedSiteId,
  { db = pool, transport = remoteTransport } = {},
) {
  const siteId = await assertAccountWhatsAppSite(user, requestedSiteId, db);
  await requireSchema(db);
  const [remote, local] = await Promise.all([
    transport.list(),
    db.query(
      "SELECT name,event,status,meta_template_id,archived_at FROM account_whatsapp_templates WHERE site_id=$1 AND status<>'DELETED'",
      [siteId],
    ),
  ]);
  return {
    templates: remote.map((template) => ({
      name: template.templateName,
      meta_template_id: template.metaTemplateId,
      status: template.templateStatus,
      category: template.templateCategory,
      imported_events: local.rows
        .filter(
          (row) =>
            String(row.meta_template_id) === String(template.metaTemplateId) &&
            row.status === "APPROVED" &&
            !row.archived_at,
        )
        .map((row) => row.event),
    })),
  };
}
export async function getAccountWhatsAppRemoteTemplate(
  user,
  requestedSiteId,
  metaId,
  { db = pool, transport = remoteTransport } = {},
) {
  await assertAccountWhatsAppSite(user, requestedSiteId, db);
  if (!/^\d+$/.test(String(metaId))) throw fail("Choose an AWS template");
  return inspectAccountWhatsAppRemoteTemplate(
    await transport.get(String(metaId)),
  );
}
export async function importAccountWhatsAppTemplate(
  user,
  input,
  { db = pool, transport = remoteTransport } = {},
) {
  assertEvent(input.event);
  const siteId = await assertAccountWhatsAppSite(user, input.site_id, db);
  await requireSchema(db);
  if (!/^\d+$/.test(String(input.meta_template_id)))
    throw fail("Choose an AWS template");
  const remote = inspectAccountWhatsAppRemoteTemplate(
    await transport.get(String(input.meta_template_id)),
  );
  if (remote.meta_template_id !== String(input.meta_template_id))
    throw fail("AWS returned a different template identity", 409);
  if (remote.status !== "APPROVED")
    throw fail("Only currently approved AWS templates can be imported", 409);
  const body = mapAccountWhatsAppRemoteBody(remote, input.event, input.fields);
  const title = titleFor(
    input.title || remote.name.replaceAll("_", " ").slice(0, 80),
  );
  const name = `aws:${siteId}:${input.event}:${remote.meta_template_id}:${remote.name}`;
  return transaction(db, siteId, async (client) => {
    const existing = (
      await client.query(
        "SELECT * FROM account_whatsapp_templates WHERE name=$1 FOR UPDATE",
        [name],
      )
    ).rows[0];
    if (
      existing &&
      (existing.body !== body ||
        existing.language !== remote.language ||
        existing.category !== remote.category ||
        Boolean(existing.has_document) !== remote.has_document ||
        JSON.stringify(existing.fields) !== JSON.stringify(input.fields))
    )
      await assertUnused(existing, client);
    const row = (
      await client.query(
        `INSERT INTO account_whatsapp_templates(site_id,event,name,title,body,fields,language,status,category,meta_template_id,created_by,has_document)
      VALUES($1,$2,$3,$4,$5,$6,$7,'APPROVED',$8,$9,$10,$11)
      ON CONFLICT(name) DO UPDATE SET title=EXCLUDED.title,body=EXCLUDED.body,fields=EXCLUDED.fields,language=EXCLUDED.language,status='APPROVED',category=EXCLUDED.category,meta_template_id=EXCLUDED.meta_template_id,has_document=EXCLUDED.has_document,archived_at=NULL,rejected_reason=NULL,updated_at=now() RETURNING *`,
        [
          siteId,
          input.event,
          name,
          title,
          body,
          input.fields,
          remote.language,
          remote.category,
          remote.meta_template_id,
          user.id,
          remote.has_document,
        ],
      )
    ).rows[0];
    return {
      ...accountWhatsAppTemplateView(row),
      notice:
        "Approved AWS template added to this project. No new Meta submission was created.",
    };
  });
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
      ).rows.map(accountWhatsAppTemplateView)
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
        documents: ACCOUNT_WHATSAPP_DOCUMENT_EVENTS.includes(key)
          ? [{ key: "PAYMENT_RECEIPT", label: "Payment receipt PDF" }]
          : [],
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
      // An administrator can still switch off a legacy text-only assignment.
      if (nextEnabled || input.template_name !== undefined)
        assertPaymentReceiptTemplate(event, template);
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
  const hasDocument = requiresPaymentReceipt(input.event);
  const compiled = compileAccountWhatsAppBody(input.event, input.body);
  const name = `dgg_acc_s${siteId}_${input.event.toLowerCase()}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  // Save a draft first: provider or connection failures never lose the edited text.
  let template = (
    await db.query(
      `INSERT INTO account_whatsapp_templates(site_id,event,name,title,body,fields,language,status,created_by,category,has_document)
    VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9,$10) RETURNING *`,
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
        hasDocument,
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
    let receiptHeader;
    let receiptSample;
    if (hasDocument) {
      if (typeof transport.uploadTemplateMedia !== "function")
        throw fail("The WhatsApp provider does not support PDF template sample uploads", 409);
      const sample = await receiptSampleForSite(input.event, siteId, db);
      receiptSample = sample;
      const headerHandle = await transport.uploadTemplateMedia(
        await renderAccountWhatsAppReceipt(input.event, sample, {
          sample: true,
          design: await getReceiptDesign(siteId, db),
        }),
        accountWhatsAppReceiptFilename(sample),
      );
      if (typeof headerHandle !== "string" || !headerHandle.trim())
        throw fail("The WhatsApp provider did not return a PDF sample header handle", 502);
      receiptHeader = {
        type: "HEADER",
        format: "DOCUMENT",
        example: { header_handle: [headerHandle] },
      };
    }
    const created = await transport.create({
      name,
      language: template.language,
      category,
      allow_category_change: true,
      parameter_format: "positional",
      components: [
        ...(receiptHeader ? [receiptHeader] : []),
        {
          type: "BODY",
          text: compiled.text,
          ...(compiled.fields.length
            ? {
                example: {
                  body_text: [
                    compiled.fields.map(
                      (key) => receiptSample
                        ? cleanAccountWhatsAppParameter(EVENTS[input.event].fields[key].value(receiptSample))
                        : EVENTS[input.event].fields[key].sample,
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
    if (
      row.meta_template_id &&
      !isImportedAccountWhatsAppTemplate(row) &&
      (
        await client.query(
          "SELECT 1 FROM account_whatsapp_templates WHERE meta_template_id=$1 AND id<>$2 AND status<>'DELETED' LIMIT 1",
          [row.meta_template_id, row.id],
        )
      ).rows.length
    )
      throw fail(
        "This AWS template is reused in another project or event. Remove those references before deleting the provider template.",
        409,
      );
    if (row.meta_template_id && !isImportedAccountWhatsAppTemplate(row))
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
  {
    db = pool,
    send = sendAccountWhatsAppTemplate,
    upload = uploadAccountWhatsAppDocument,
    transport = remoteTransport,
  } = {},
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
    assertPaymentReceiptTemplate(input.event, selected);
    const claimed = (
      await client.query(
        "INSERT INTO account_whatsapp_messages(site_id,event,ref_id,dedupe_key,is_test,status,phone,template) VALUES($1,$2,0,$3,true,'SENDING',$4,$5) RETURNING *",
        [
          siteId,
          input.event,
          `test:${randomUUID()}`,
          to,
          accountWhatsAppProviderName(selected),
        ],
      )
    ).rows[0];
    return { template: selected, row: claimed };
  });
  let messageId;
  try {
    const sample = requiresPaymentReceipt(input.event)
      ? await receiptSampleForSite(input.event, siteId, db)
      : null;
    if (
      isImportedAccountWhatsAppTemplate(template) &&
      (send === sendAccountWhatsAppTemplate || transport !== remoteTransport)
    )
      assertAccountWhatsAppImportedDefinition(
        template,
        await transport.get(template.meta_template_id),
      );
    messageId = await send(
      to,
      accountWhatsAppProviderName(template),
      template.fields.map((key) =>
        cleanAccountWhatsAppParameter(sample
          ? EVENTS[input.event].fields[key]?.value(sample)
          : EVENTS[input.event].fields[key]?.sample),
      ),
      {
        language: template.language,
        ref: `account-wa-test:${row.id}`,
        ...(template.has_document
          ? {
              media: await receiptMedia(
                input.event,
                sample,
                upload,
                { sample: true, db },
              ),
            }
          : {}),
      },
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
    template: accountWhatsAppProviderName(template),
    message_id: messageId,
    sample_only: true,
  };
}

const MEMBER_COLUMNS = `m.full_name,m.phone,m.whatsapp,COALESCE(to_jsonb(m)->>'member_code','CLT-' || m.id::text) AS member_code,s.name AS site_name`;
const PLOT_COLUMNS = `plot_buyer.full_name,plot_buyer.phone,plot_buyer.whatsapp,COALESCE(to_jsonb(plot_buyer)->>'member_code','CLT-' || plot_buyer.id::text) AS member_code,p.plot_no,p.site_id,s.name AS site_name`;
// Explicit printable facts only: never include KYC documents or arbitrary member columns.
const RECEIPT_RECORD_FIELDS = [
  "bank_reference", "reference_no", "transaction_no", "reference", "utr",
  "bank_details", "bank_account_name", "bank_name", "bank_account_no", "account_no", "branch", "bank_ifsc", "ifsc",
  "cheque_no", "cheque_apply_date", "cheque_transaction_date", "transaction_time",
  "narration", "particular", "particulars", "description", "details", "note", "notes", "purpose", "by_note", "remarks", "remark", "remark2", "received_by",
  "booking_reference", "booking_no", "plot_reference", "assigned_admin_id",
  "customer_signature_url", "authority_signature_url", "evidence_photo_url", "voucher_url",
];
const receiptRecordColumns = (alias) => RECEIPT_RECORD_FIELDS
  .map((key) => `to_jsonb(${alias})->>'${key}' AS ${key}`).join(",");
const RECEIPT_PLOT_COLUMNS = `to_jsonb(p)->>'plot_size' AS plot_size,to_jsonb(p)->>'plot_rate' AS plot_rate,to_jsonb(p)->>'unit_type' AS unit_type,to_jsonb(p)->'unit_details' AS unit_details,to_jsonb(p)->>'project_type' AS project_type,to_jsonb(p)->>'booking_by' AS broker_name,
  COALESCE(NULLIF(BTRIM(to_jsonb(p)->>'buyer_phone'),''),NULLIF(BTRIM(plot_buyer.phone),'')) AS buyer_phone,
  concat_ws(', ',NULLIF(to_jsonb(s)->>'address',''),NULLIF(to_jsonb(s)->>'city',''),NULLIF(to_jsonb(s)->>'state','')) AS site_address,
  (SELECT CASE WHEN COUNT(*)=1 THEN MIN(m.phone) END FROM members m WHERE m.site_id=p.site_id AND UPPER(BTRIM(m.full_name))=UPPER(BTRIM(to_jsonb(p)->>'booking_by'))) AS broker_phone,
  (SELECT CASE WHEN COUNT(*)=1 THEN MIN(to_jsonb(m)->>'team') END FROM members m WHERE m.site_id=p.site_id AND UPPER(BTRIM(m.full_name))=UPPER(BTRIM(to_jsonb(p)->>'booking_by'))) AS broker_team`;
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
    query = `SELECT ${MEMBER_COLUMNS},m.site_id,EXISTS(SELECT 1 FROM kyc_cases k WHERE k.client_member_id=m.id AND k.site_id=m.site_id AND k.status='VERIFIED') AS kyc_verified FROM members m JOIN sites s ON s.id=m.site_id WHERE m.id=$1 AND m.site_id=$2 AND ${CLIENT_PREDICATE}`;
  else if (event === "KYC_VERIFIED")
    query = `SELECT ${MEMBER_COLUMNS},k.site_id FROM kyc_cases k JOIN members m ON m.id=k.client_member_id AND m.site_id=k.site_id JOIN sites s ON s.id=k.site_id WHERE k.id=$1 AND k.site_id=$2 AND k.status='VERIFIED' AND ${CLIENT_PREDICATE}`;
  else if (event === "PLOT_BOOKED")
    query = `SELECT ${PLOT_COLUMNS} FROM plots p JOIN sites s ON s.id=p.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE p.id=$1 AND p.site_id=$2 AND UPPER(p.status)='BOOKED' AND LOWER(COALESCE(to_jsonb(p)->>'approval_status',''))='approved' AND ${PLOT_CLIENT_PREDICATE}`;
  else if (["PAYMENT_RECEIVED", "PAYMENT_SENT"].includes(event))
    query = `SELECT ${PLOT_COLUMNS},${RECEIPT_PLOT_COLUMNS},${receiptRecordColumns("pp")},pp.id AS source_id,'plot_payment' AS receipt_module,pp.amount,pp.payment_type,pp.payment_type AS payment_mode,pp.payment_from,to_jsonb(pp)->>'money_transfer_id' AS money_transfer_id,to_jsonb(pp)->>'money_transfer_role' AS money_transfer_role,to_jsonb(pp)->>'entry_transfer_id' AS entry_transfer_id,pp.date AS payment_date,'ACK-' || pp.id::text AS receipt_no,pp.status,pp.cheque_status FROM plot_payments pp JOIN plots p ON p.id=pp.plot_id AND p.site_id=pp.site_id JOIN sites s ON s.id=p.site_id ${PLOT_BUYER_MEMBER_JOIN} WHERE pp.id=$1 AND p.site_id=$2 AND ${PLOT_CLIENT_PREDICATE}`;
  else if (event === "INSTALLMENT_RECEIVED")
    query = `SELECT ${PLOT_COLUMNS},${RECEIPT_PLOT_COLUMNS},${receiptRecordColumns("pip")},pip.id AS source_id,'plot_installment_payment' AS receipt_module,pip.amount,pip.payment_mode,pip.payment_date,'ACK-' || pip.id::text AS receipt_no,pip.status,pip.cheque_status,to_jsonb(pip)->>'entry_transfer_id' AS entry_transfer_id,pi.installment_name FROM plot_installment_payments pip JOIN plots p ON p.id=pip.plot_id JOIN sites s ON s.id=p.site_id LEFT JOIN plot_installments pi ON pi.id=pip.installment_id AND pi.plot_id=p.id ${PLOT_BUYER_MEMBER_JOIN} WHERE pip.id=$1 AND p.site_id=$2 AND ${PLOT_CLIENT_PREDICATE}`;
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
  if (requiresPaymentReceipt(event)) {
    // The non-cash account assignment belongs to the canonical ledger mirror.
    // Legacy installations without bank mapping retain their recorded text.
    const available = (await db.query("SELECT to_regclass('public.cash_flow_entries') IS NOT NULL AND to_regclass('public.bank_accounts') IS NOT NULL AS banks,to_regclass('public.transaction_party_links') IS NOT NULL AS parties")).rows[0] || {};
    if (available.banks) {
      const bank = (await db.query(
        `SELECT ba.name AS bank_account_name,COALESCE(NULLIF(to_jsonb(ba)->>'bank_name',''),ba.name) AS bank_name,
          to_jsonb(ba)->>'account_no' AS bank_account_no,to_jsonb(ba)->>'account_no' AS account_no,
          to_jsonb(ba)->>'ifsc' AS bank_ifsc,to_jsonb(ba)->>'ifsc' AS ifsc,to_jsonb(ba)->>'branch' AS branch
          FROM cash_flow_entries cfe
          JOIN bank_accounts ba ON ba.id=cfe.bank_account_id AND ba.site_id=cfe.site_id
          WHERE cfe.site_id=$1 AND cfe.source_module=$2 AND cfe.source_id=$3
          ORDER BY cfe.id DESC LIMIT 1`,
        [siteId, event === "INSTALLMENT_RECEIVED" ? "plot_installment_payments" : "plot_payments", refId],
      )).rows[0];
      if (bank) Object.assign(data, bank);
    }
    // Related-party notes use the native receipt identity, never an overlapping
    // payment ID from a different module or site.
    data.related_party = "";
    if (available.parties) {
      const party = (await db.query(
        `SELECT m.full_name FROM transaction_party_links l
          JOIN members m ON m.id=l.member_id AND m.site_id=l.site_id
          WHERE l.site_id=$1 AND l.source_key=$2 AND l.source_id=$3 LIMIT 1`,
        [siteId, data.receipt_module, refId],
      )).rows[0];
      data.related_party = party?.full_name || "";
    }
    data.assigned_to = "";
    const approverId = Number(data.assigned_admin_id);
    if (Number.isSafeInteger(approverId) && approverId > 0) {
      const approver = (await db.query(
        `SELECT to_jsonb(u)->>'name' AS name FROM users u
          JOIN sites s ON s.id=$2
          WHERE u.id=$1 AND (to_jsonb(u)->>'organization_id' IS NULL OR to_jsonb(u)->>'organization_id'=to_jsonb(s)->>'organization_id')`,
        [approverId, siteId],
      )).rows[0];
      data.assigned_to = approver?.name || "";
    }
  }
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
  {
    db = pool,
    send = sendAccountWhatsAppTemplate,
    upload = uploadAccountWhatsAppDocument,
    transport = remoteTransport,
  } = {},
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
        template ? accountWhatsAppProviderName(template) : null,
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
    if (requiresPaymentReceipt(row.event) && !template.has_document)
      return finish("SKIPPED", "Payment receipt PDF requires an approved document-header template. Create or import a PDF template in WhatsApp Studio before enabling payment messages.");
    if (
      isImportedAccountWhatsAppTemplate(template) &&
      (send === sendAccountWhatsAppTemplate || transport !== remoteTransport)
    )
      assertAccountWhatsAppImportedDefinition(
        template,
        await transport.get(template.meta_template_id),
      );
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
    if (
      row.event === "CLIENT_ONBOARDED" &&
      data.kyc_verified &&
      accountTemplateStatesPendingKyc(template.body)
    )
      return finish(
        "SKIPPED",
        "Client KYC is already verified; this template states KYC Pending.",
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
    let media;
    if (template.has_document) {
      media = await receiptMedia(row.event, data, upload, { db });
      const current = await loadAccountWhatsAppContext(
        row.event,
        row.ref_id,
        row.site_id,
        db,
      );
      const snapshot = (value) => JSON.stringify(Object.keys(value || {}).sort()
        .map((key) => [key, value[key] ?? null]));
      if (!current || snapshot(current) !== snapshot(data))
        return finish(
          "SKIPPED",
          "Payment changed while preparing the receipt; no message was sent.",
        );
    }
    messageId = await send(
      phone,
      accountWhatsAppProviderName(template),
      template.fields.map((key) =>
        cleanAccountWhatsAppParameter(spec.fields[key].value(data)),
      ),
      {
        language: template.language,
        ref: `account-wa:${row.id}`,
        ...(media ? { media } : {}),
      },
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
  upload = uploadAccountWhatsAppDocument,
  transport = remoteTransport,
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
      await deliverAccountWhatsApp(row, { db, send, transport, upload });
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
