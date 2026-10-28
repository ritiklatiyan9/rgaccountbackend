/** Accountancy-only WhatsApp event contracts. No I/O, credentials or customer data. */
export const accountWhatsAppError = (message, status = 400) =>
  Object.assign(new Error(message), { status, statusCode: status });
export function accountWhatsAppCategory(value) {
  const category =
    value === undefined
      ? "UTILITY"
      : typeof value === "string"
        ? value.trim().toUpperCase()
        : "";
  if (!["UTILITY", "MARKETING"].includes(category))
    throw accountWhatsAppError(
      "Choose Utility or Marketing as the message category",
    );
  return category;
}
const field = (label, sample, value) => ({ label, sample, value });
const clean = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim() || "-";
const money = (value) =>
  Math.abs(Number(value) || 0).toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  });
const date = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "-"
    : d.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });
};
const CUSTOMER = {
  customer_name: field("Customer name", "Rahul Sharma", (d) =>
    clean(d.full_name),
  ),
  member_id: field("Member ID", "CLT-00123", (d) => clean(d.member_code)),
  project: field("Project", "Defence Garden", (d) => clean(d.site_name)),
};
const PLOT = {
  ...CUSTOMER,
  plot_no: field("Plot number", "A12", (d) => clean(d.plot_no)),
};
const PAYMENT = {
  ...PLOT,
  registration_no: field("Client registration (Member ID)", "CLT-00123", (d) =>
    clean(d.member_code),
  ),
  amount: field("Amount", "₹1,00,000.00", (d) => money(d.amount)),
  payment_mode: field("Payment mode", "BANK", (d) => clean(d.payment_mode)),
  payment_date: field("Payment date", "23 Oct 2026", (d) =>
    date(d.payment_date),
  ),
  receipt_no: field("Receipt / reference number", "ACK-100123", (d) =>
    clean(d.receipt_no),
  ),
};
const branded = (...paragraphs) =>
  [
    "*DEFENCE GARDEN GROUP*",
    ...paragraphs,
    "For assistance, please contact our office.\n*Team Defence Garden Group*",
  ].join("\n\n");
const event = (
  label,
  module,
  submodule,
  trigger,
  description,
  fields,
  body,
) => ({ label, module, submodule, trigger, description, fields, body });
export const ACCOUNT_WHATSAPP_EVENTS = {
  CLIENT_ONBOARDED: event(
    "Client onboarded",
    "Clients",
    "Onboarding",
    "New client registration saved",
    "Confirm a completed client registration with its Member ID.",
    CUSTOMER,
    "*Client registration confirmation*\n\nDear {customer_name},\n\nYour client registration for {project} is complete.\n*Member ID:* {member_id}\n\nUse this ID when contacting our office about your account.\n\nDefence Garden Group",
  ),
  KYC_VERIFIED: event(
    "KYC verified",
    "Clients",
    "KYC verification",
    "KYC verification completed",
    "Confirm that client verification has been completed.",
    CUSTOMER,
    "*KYC verification confirmation*\n\nDear {customer_name},\n\nYour KYC verification for {project} is complete.\n*Member ID:* {member_id}\n\nDefence Garden Group",
  ),
  PLOT_BOOKED: event(
    "Plot booking confirmed",
    "Plot payments",
    "Booking confirmation",
    "Plot changes to Booked with a linked client",
    "Confirm a new plot booking after the booking is saved.",
    PLOT,
    branded(
      "Dear {customer_name},",
      "Your plot booking at {project} is confirmed.\n*Plot:* {plot_no}\n*Member ID:* {member_id}",
      "Please keep these details for future communication.",
    ),
  ),
  PAYMENT_RECEIVED: event(
    "Payment received",
    "Plot payments",
    "Approved receipts",
    "Non-cash plot receipt approved; cheques cleared",
    "Send receipts for approved non-cash payments only. Cash is always excluded.",
    PAYMENT,
    branded(
      "Dear {customer_name},",
      "We have received your payment for Plot {plot_no} at {project}.\n*Amount:* {amount}\n*Mode:* {payment_mode}\n*Date:* {payment_date}\n*Reference:* {receipt_no}",
      "Thank you for your payment.",
    ),
  ),
  PAYMENT_SENT: event(
    "Payment sent / refund",
    "Plot payments",
    "Approved refunds",
    "Non-cash outgoing plot payment approved; cheques cleared",
    "Confirm approved refunds or outgoing plot payments. Cash is always excluded.",
    PAYMENT,
    branded(
      "Dear {customer_name},",
      "Your payment / refund for Plot {plot_no} at {project} has been processed.\n*Amount:* {amount}\n*Mode:* {payment_mode}\n*Date:* {payment_date}\n*Reference:* {receipt_no}",
      "Please retain this reference for your records.",
    ),
  ),
  INSTALLMENT_RECEIVED: event(
    "Installment payment received",
    "Installment tracker",
    "Approved installment receipts",
    "Non-cash direct installment receipt approved; cheques cleared",
    "Confirm a direct installment receipt after approval. Cash is always excluded.",
    {
      ...PAYMENT,
      installment_name: field("Installment name", "Installment 2", (d) =>
        clean(d.installment_name),
      ),
    },
    branded(
      "Dear {customer_name},",
      "Your payment towards {installment_name} for Plot {plot_no} at {project} has been received.\n*Amount:* {amount}\n*Mode:* {payment_mode}\n*Date:* {payment_date}\n*Reference:* {receipt_no}",
      "Thank you for keeping your installment plan up to date.",
    ),
  ),
  INSTALLMENT_DUE: event(
    "Installment due reminder",
    "Installment tracker",
    "Scheduled reminders",
    "Once per future due installment at the selected lead time",
    "Remind clients of an unpaid installment. Uses current allocated balances; no historical reminders are backfilled.",
    {
      ...PLOT,
      installment_name: field("Installment name", "Installment 2", (d) =>
        clean(d.installment_name),
      ),
      amount_due: field("Remaining installment amount", "₹50,000.00", (d) =>
        money(d.remaining),
      ),
      due_date: field("Due date", "26 Oct 2026", (d) => date(d.due_date)),
    },
    branded(
      "Dear {customer_name},",
      "This is a reminder for {installment_name} on Plot {plot_no} at {project}.\n*Amount due:* {amount_due}\n*Due date:* {due_date}",
      "If you have already paid, please contact our office to reconcile your account.",
    ),
  ),
  REGISTRY_COMPLETED: event(
    "Registry congratulations",
    "Plot registry",
    "Completed deed handover",
    "Registry deed handed over with registration date and deed on file",
    "Congratulate the client once their registered deed has been handed over. Creating a NOC does not trigger this message.",
    {
      ...PLOT,
      registry_date: field("Registry date", "23 Oct 2026", (d) =>
        date(d.registry_date),
      ),
    },
    branded(
      "Dear {customer_name},",
      "Congratulations! The registered deed for Plot {plot_no} at {project} has been handed over.\n*Registry date:* {registry_date}",
      "Thank you for placing your trust in Defence Garden Group. We wish you a wonderful journey ahead.",
    ),
  ),
};
export const ACCOUNT_WHATSAPP_POLICY = Object.freeze({
  cash_excluded: true,
  allowed_modes: ["BANK", "CHEQUE", "UPI", "NEFT", "RTGS", "IMPS", "TRANSFER"],
  approval_required: true,
  cheque_clearance_required: true,
  no_historical_backfill: true,
  delivery_status:
    "SENT means accepted by WhatsApp provider, not confirmed delivered.",
});
export const accountWhatsAppPhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  const mobile =
    digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return /^[6-9]\d{9}$/.test(mobile) ? `+91${mobile}` : null;
};
export const cleanAccountWhatsAppParameter = clean;
export const cleanAccountWhatsAppSpacing = (value) =>
  String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+$/gm, "")
    .replace(/\n(?:[^\S\n]*\n){2,}/gu, "\n\n")
    .trim();
export function compileAccountWhatsAppBody(eventName, body) {
  const spec = ACCOUNT_WHATSAPP_EVENTS[eventName];
  if (!spec) throw accountWhatsAppError("Unknown module event", 404);
  const source = String(body ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (/[{}]/.test(source.replace(/\{[a-z_]+\}/g, "")))
    throw accountWhatsAppError(
      "Use supported {field} variables; remove incomplete or double braces",
    );
  if (/\n(?:[^\S\n]*\n){2,}/u.test(source))
    throw accountWhatsAppError(
      "Use at most one blank line between paragraphs. Use Clean spacing before submitting.",
    );
  const emojis = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(source),
  ].filter(({ segment }) =>
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment),
  ).length;
  if (emojis > 10)
    throw accountWhatsAppError(
      "WhatsApp permits at most 10 emojis in a template.",
    );
  const fields = [];
  const text = source.replace(/\{([a-z_]+)\}/g, (_, key) => {
    if (!spec.fields[key])
      throw accountWhatsAppError(`{${key}} is not available for ${spec.label}`);
    fields.push(key);
    return `{{${fields.length}}}`;
  });
  if (!text || text.length > 1024)
    throw accountWhatsAppError("Write a message with at most 1024 characters.");
  if (/^\{\{/.test(text) || /\}\}[^\p{L}\p{N}]*$/u.test(text))
    throw accountWhatsAppError(
      "Start and end the message with text, not a {field}.",
    );
  if (/\}\}\s*\{\{/.test(text))
    throw accountWhatsAppError("Put some text between two {fields}.");
  return {
    text,
    fields,
    body: source,
    preview: source.replace(
      /\{([a-z_]+)\}/g,
      (_, key) => spec.fields[key].sample,
    ),
  };
}
/** Fail closed for unknown, mixed or cash payment modes; outgoing rows have a negative amount. */
export function isAccountWhatsAppPaymentEligible(data, eventName) {
  const mode = String(data.payment_mode ?? data.payment_type ?? "")
    .trim()
    .toUpperCase();
  const from = String(data.payment_from ?? "")
    .trim()
    .toUpperCase();
  if (
    !ACCOUNT_WHATSAPP_POLICY.allowed_modes.includes(mode) ||
    /\bCASH\b/.test(mode) ||
    /\bCASH\b/.test(from)
  )
    return false;
  if (String(data.status).toLowerCase() !== "approved") return false;
  if (
    mode === "CHEQUE" &&
    String(data.cheque_status).toUpperCase() !== "CLEARED"
  )
    return false;
  const amount = Number(data.amount);
  return (
    Number.isFinite(amount) &&
    (eventName === "PAYMENT_SENT" ? amount < 0 : amount > 0)
  );
}
