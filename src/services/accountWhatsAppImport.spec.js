import {
  ACCOUNT_WHATSAPP_EVENTS,
  accountWhatsAppError,
} from "./accountWhatsApp.spec.js";

// Namespaced local references let one approved AWS template serve several
// projects/events without changing the existing schema or the shared AWS asset.
export const isImportedAccountWhatsAppTemplate = (template) =>
  String(template?.name || "").startsWith("aws:");
export function accountWhatsAppProviderName(template) {
  if (!isImportedAccountWhatsAppTemplate(template)) return template?.name;
  const match = /^aws:(\d+):([A-Z_]+):(\d+):([a-z0-9_]+)$/.exec(template.name);
  if (
    !match ||
    (template.site_id && Number(match[1]) !== Number(template.site_id)) ||
    (template.event && match[2] !== template.event)
  )
    throw accountWhatsAppError("Invalid imported AWS template reference", 409);
  if (
    template.meta_template_id &&
    match[3] !== String(template.meta_template_id)
  )
    throw accountWhatsAppError("Imported AWS template identity changed", 409);
  return match[4];
}
export const accountWhatsAppTemplateView = (template) => ({
  ...template,
  imported: isImportedAccountWhatsAppTemplate(template),
  provider_name: accountWhatsAppProviderName(template),
});

export function inspectAccountWhatsAppRemoteTemplate(definition) {
  if (!definition || typeof definition !== "object")
    throw accountWhatsAppError("AWS returned an invalid template", 502);
  const components = Array.isArray(definition.components)
    ? definition.components
    : [];
  const bodies = components.filter((component) => component.type === "BODY");
  const body = typeof bodies[0]?.text === "string" ? bodies[0].text : "";
  const positions = [
    ...new Set(
      [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1])),
    ),
  ].sort((a, b) => a - b);
  let unsupported_reason = null;
  if (components.some((component) => component.type === "HEADER"))
    unsupported_reason =
      "This template requires a header or attachment. Import currently supports text-only templates.";
  else if (
    bodies.length !== 1 ||
    components.some((component) => component.type !== "BODY")
  )
    unsupported_reason =
      "This template has buttons, a footer or other components. Import currently supports text-only message bodies.";
  else if (
    !body ||
    /\{\{|\}\}/.test(body.replace(/\{\{\d+\}\}/g, "")) ||
    positions.some((position, index) => position !== index + 1)
  )
    unsupported_reason =
      "This template does not use a supported consecutive positional field layout.";
  else if (
    !/^[a-z0-9_]+$/.test(definition.name || "") ||
    !definition.id ||
    !definition.language
  )
    unsupported_reason = "AWS template identity or language is missing.";
  return {
    name: definition.name,
    meta_template_id: String(definition.id || ""),
    status: definition.status,
    category: definition.category,
    language: definition.language,
    body,
    parameters: positions.map((position) => ({
      position,
      example: String(bodies[0]?.example?.body_text?.[0]?.[position - 1] ?? ""),
    })),
    supported: !unsupported_reason,
    unsupported_reason,
  };
}
export function mapAccountWhatsAppRemoteBody(remote, event, fields) {
  const spec = ACCOUNT_WHATSAPP_EVENTS[event];
  if (!remote.supported)
    throw accountWhatsAppError(remote.unsupported_reason, 409);
  if (
    !spec ||
    !Array.isArray(fields) ||
    fields.length !== remote.parameters.length ||
    fields.some(
      (field) =>
        typeof field !== "string" || !Object.hasOwn(spec.fields, field),
    )
  )
    throw accountWhatsAppError(
      "Map every AWS variable to a supported field for this module",
    );
  return remote.body.replace(
    /\{\{(\d+)\}\}/g,
    (_, position) => `{${fields[Number(position) - 1]}}`,
  );
}
export function assertAccountWhatsAppImportedDefinition(template, definition) {
  const remote = inspectAccountWhatsAppRemoteTemplate(definition);
  if (
    remote.status !== "APPROVED" ||
    remote.meta_template_id !== String(template.meta_template_id) ||
    remote.name !== accountWhatsAppProviderName(template)
  )
    throw accountWhatsAppError(
      "The imported AWS template is no longer the approved version selected for this event.",
      409,
    );
  if (
    !remote.supported ||
    remote.language !== template.language ||
    remote.category !== template.category ||
    mapAccountWhatsAppRemoteBody(remote, template.event, template.fields) !==
      template.body
  )
    throw accountWhatsAppError(
      "The AWS template content changed. Import it again and review the variable mapping before using it.",
      409,
    );
  return remote;
}
export const accountTemplateStatesPendingKyc = (body) =>
  /\bKYC(?:\s+STATUS)?\s*:?\s+PENDING\b/i.test(
    String(body || "").replace(/[*_~]/g, ""),
  );
