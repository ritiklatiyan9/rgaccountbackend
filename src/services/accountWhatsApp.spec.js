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
/** Message languages. English is always sent; Hindi is an optional second message per module. */
export const ACCOUNT_WHATSAPP_LANGUAGES = Object.freeze({
  en: { code: "en", label: "English", native: "English" },
  hi: { code: "hi", label: "Hindi", native: "हिन्दी" },
});
/** 'en_US' and 'en' are both English. Anything unrecognised is returned as-is. */
export const accountWhatsAppLanguageGroup = (value) =>
  String(value || "en")
    .split(/[_-]/)[0]
    .toLowerCase();
export function accountWhatsAppLanguage(value) {
  if (value === undefined || value === null || value === "") return "en";
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ACCOUNT_WHATSAPP_LANGUAGES[code])
    throw accountWhatsAppError("Choose English or Hindi as the message language");
  return code;
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
const INSTALLMENT_REMINDER = {
  ...PLOT,
  installment_name: field("Installment name", "Installment 2", (d) => clean(d.installment_name)),
  amount_due: field("Remaining installment amount", "₹50,000.00", (d) => money(d.remaining)),
  due_date: field("Due date", "26 Oct 2026", (d) => date(d.due_date)),
};
export const SHOP_INSTALLMENT_REMINDER = "SHOP_INSTALLMENT_REMINDER";
export const SHOP_REMINDER_LEAD_DAYS = 3;
export const SHOP_REMINDER_GRACE_DAYS = 15;
export const SHOP_INSTALLMENT_REMINDER_BODY = [
  "*Shop installment reminder / दुकान की किस्त का अनुस्मारक*",
  "Dear {customer_name},\nPlease pay the outstanding balance on your shop installment. If you have already paid, please contact our office so we can update your account.",
  "प्रिय {customer_name},\nकृपया अपनी दुकान की बकाया किस्त का भुगतान करें। यदि आपने भुगतान कर दिया है, तो खाते में भुगतान दर्ज कराने के लिए हमारे कार्यालय से संपर्क करें।",
  "*Project / परियोजना:* {project}\n*Shop / दुकान:* {plot_no}\n*Installment / किस्त:* {installment_name}\n*Outstanding amount / बकाया राशि:* {amount_due}\n*Due date / देय तिथि:* {due_date}",
  "Defence Garden Group / डिफेंस गार्डन ग्रुप",
].join("\n\n");

export function isBilingualShopReminder(body) {
  const text = String(body || "").replace(/\{[a-z_]+\}/g, "");
  return /\p{Script=Latin}/u.test(text) && /\p{Script=Devanagari}/u.test(text);
}

const branded = (...paragraphs) =>
  [
    "*DEFENCE GARDEN GROUP*",
    ...paragraphs,
    "For assistance, please contact our office.\n*Team Defence Garden Group*",
  ].join("\n\n");
const brandedHi = (...paragraphs) =>
  [
    "*डिफेंस गार्डन ग्रुप*",
    ...paragraphs,
    "सहायता के लिए कृपया हमारे कार्यालय से संपर्क करें।\n*टीम डिफेंस गार्डन ग्रुप*",
  ].join("\n\n");
const event = (
  label,
  module,
  submodule,
  trigger,
  description,
  fields,
  body,
  body_hi,
) => ({ label, module, submodule, trigger, description, fields, body, body_hi });
export const ACCOUNT_WHATSAPP_EVENTS = {
  CLIENT_ONBOARDED: event(
    "Client onboarded",
    "Clients",
    "Onboarding",
    "New client registration saved",
    "Confirm a completed client registration with its Member ID.",
    CUSTOMER,
    "*Client registration confirmation*\n\nDear {customer_name},\n\nYour client registration for {project} is complete.\n*Member ID:* {member_id}\n\nUse this ID when contacting our office about your account.\n\nDefence Garden Group",
    "*क्लाइंट पंजीकरण की पुष्टि*\n\nप्रिय {customer_name},\n\n{project} के लिए आपका क्लाइंट पंजीकरण पूर्ण हो गया है।\n*मेंबर आईडी:* {member_id}\n\nअपने खाते के संबंध में हमारे कार्यालय से संपर्क करते समय इस आईडी का उपयोग करें।\n\nडिफेंस गार्डन ग्रुप",
  ),
  KYC_VERIFIED: event(
    "KYC verified",
    "Clients",
    "KYC verification",
    "KYC verification completed",
    "Confirm that client verification has been completed.",
    CUSTOMER,
    "*KYC verification confirmation*\n\nDear {customer_name},\n\nYour KYC verification for {project} is complete.\n*Member ID:* {member_id}\n\nDefence Garden Group",
    "*KYC सत्यापन की पुष्टि*\n\nप्रिय {customer_name},\n\n{project} के लिए आपका KYC सत्यापन पूर्ण हो गया है।\n*मेंबर आईडी:* {member_id}\n\nडिफेंस गार्डन ग्रुप",
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
    brandedHi(
      "प्रिय {customer_name},",
      "{project} में आपकी प्लॉट बुकिंग की पुष्टि हो गई है।\n*प्लॉट:* {plot_no}\n*मेंबर आईडी:* {member_id}",
      "कृपया भविष्य के संपर्क के लिए ये विवरण सुरक्षित रखें।",
    ),
  ),
  PAYMENT_RECEIVED: event(
    "Payment received",
    "Plot payments",
    "Approved receipts",
    "Plot receipt approved; cheques cleared",
    "Send receipts for approved payments, including cash.",
    PAYMENT,
    branded(
      "Dear {customer_name},",
      "We have received your payment for Plot {plot_no} at {project}.\n*Amount:* {amount}\n*Mode:* {payment_mode}\n*Date:* {payment_date}\n*Reference:* {receipt_no}",
      "Thank you for your payment.",
    ),
    brandedHi(
      "प्रिय {customer_name},",
      "{project} में प्लॉट {plot_no} के लिए आपका भुगतान हमें प्राप्त हो गया है।\n*राशि:* {amount}\n*माध्यम:* {payment_mode}\n*दिनांक:* {payment_date}\n*संदर्भ:* {receipt_no}",
      "आपके भुगतान के लिए धन्यवाद।",
    ),
  ),
  PAYMENT_SENT: event(
    "Payment sent / refund",
    "Plot payments",
    "Approved refunds",
    "Outgoing plot payment approved; cheques cleared",
    "Confirm approved refunds or outgoing plot payments, including cash.",
    PAYMENT,
    branded(
      "Dear {customer_name},",
      "Your payment / refund for Plot {plot_no} at {project} has been processed.\n*Amount:* {amount}\n*Mode:* {payment_mode}\n*Date:* {payment_date}\n*Reference:* {receipt_no}",
      "Please retain this reference for your records.",
    ),
    brandedHi(
      "प्रिय {customer_name},",
      "{project} में प्लॉट {plot_no} के लिए आपका भुगतान / रिफंड प्रोसेस कर दिया गया है।\n*राशि:* {amount}\n*माध्यम:* {payment_mode}\n*दिनांक:* {payment_date}\n*संदर्भ:* {receipt_no}",
      "कृपया अपने रिकॉर्ड के लिए यह संदर्भ संख्या सुरक्षित रखें।",
    ),
  ),
  POOL_PAYMENT_RECEIVED: event(
    "Pool money receipt",
    "Pool money",
    "Approved collections",
    "Booking or draw receipt approved; cheques cleared",
    "Send the receipt to the registered client after the collection is approved.",
    Object.fromEntries(["customer_name", "project", "amount", "payment_mode", "payment_date", "receipt_no"]
      .map(key => [key, PAYMENT[key]])),
    branded(
      "Dear {customer_name},",
      "We have received your payment for {project}.\n*Amount:* {amount}\n*Mode:* {payment_mode}\n*Date:* {payment_date}\n*Receipt:* {receipt_no}",
      "Your receipt is attached.",
    ),
    brandedHi(
      "प्रिय {customer_name},",
      "{project} में आपका भुगतान प्राप्त हो गया है।\n*राशि:* {amount}\n*माध्यम:* {payment_mode}\n*दिनांक:* {payment_date}\n*रसीद:* {receipt_no}",
      "आपकी रसीद संलग्न है।",
    ),
  ),
  INSTALLMENT_RECEIVED: event(
    "Installment payment received",
    "Installment tracker",
    "Approved installment receipts",
    "Direct installment receipt approved; cheques cleared",
    "Confirm approved direct installment receipts, including cash.",
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
    brandedHi(
      "प्रिय {customer_name},",
      "{project} में प्लॉट {plot_no} के लिए {installment_name} के अंतर्गत आपका भुगतान प्राप्त हो गया है।\n*राशि:* {amount}\n*माध्यम:* {payment_mode}\n*दिनांक:* {payment_date}\n*संदर्भ:* {receipt_no}",
      "अपनी किस्त योजना को अद्यतन रखने के लिए धन्यवाद।",
    ),
  ),
  INSTALLMENT_DUE: event(
    "Installment due reminder",
    "Installment tracker",
    "Scheduled reminders",
    "Once per future due installment at the selected lead time",
    "Remind clients of an unpaid installment. Uses current allocated balances; no historical reminders are backfilled.",
    INSTALLMENT_REMINDER,
    branded(
      "Dear {customer_name},",
      "This is a reminder for {installment_name} on Plot {plot_no} at {project}.\n*Amount due:* {amount_due}\n*Due date:* {due_date}",
      "If you have already paid, please contact our office to reconcile your account.",
    ),
    brandedHi(
      "प्रिय {customer_name},",
      "यह {project} में प्लॉट {plot_no} की {installment_name} के लिए एक अनुस्मारक है।\n*देय राशि:* {amount_due}\n*देय तिथि:* {due_date}",
      "यदि आप भुगतान कर चुके हैं, तो कृपया अपना खाता मिलान कराने के लिए हमारे कार्यालय से संपर्क करें।",
    ),
  ),
  [SHOP_INSTALLMENT_REMINDER]: event(
    "Daily shop installment reminder",
    "Installment tracker",
    "Bilingual reminders",
    "Every day from 3 days before the due date through the 15th day after it",
    "Send one WhatsApp message in Hindi and English per unpaid shop installment per day when an approved template is applied and the event is enabled.",
    INSTALLMENT_REMINDER,
    SHOP_INSTALLMENT_REMINDER_BODY,
  ),
  INSTALLMENT_OVERDUE: event(
    "Overdue installment penalty",
    "Installment tracker",
    "Overdue penalty notices",
    "After the due date, while an installment remains unpaid",
    "Project-specific penalty notice, using current posted receipts including cash. Only installments becoming overdue after activation are eligible.",
    {
      ...PLOT,
      installment_name: field("Installment name", "Installment 2", (d) => clean(d.installment_name)),
      amount_due: field("Unpaid overdue installment", "₹50,000.00", (d) => money(d.remaining)),
      due_date: field("Due date", "09 Nov 2026", (d) => date(d.due_date)),
      days_overdue: field("Days overdue", "1", (d) => clean(d.days_overdue)),
      penalty_amount: field("Penalty / current unpaid balance interest estimate", "₹24.66", (d) => money(d.penalty_amount)),
      as_of_date: field("Notice calculation date", "10 Nov 2026", (d) => date(d.as_of_date)),
    },
    "*Overdue installment notice*\n\nDear {customer_name},\n\nYour {installment_name} for unit {plot_no} at {project} was due on {due_date}.\n*Unpaid amount:* {amount_due}\n\nPlease contact our office to settle the overdue installment and review the applicable project penalty.\n\nDefence Garden Group",
    "*बकाया किस्त की सूचना*\n\nप्रिय {customer_name},\n\n{project} में यूनिट {plot_no} की आपकी {installment_name} की देय तिथि {due_date} थी।\n*अदत्त राशि:* {amount_due}\n\nबकाया किस्त का भुगतान करने और लागू परियोजना पेनल्टी की जानकारी के लिए कृपया हमारे कार्यालय से संपर्क करें।\n\nडिफेंस गार्डन ग्रुप",
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
    brandedHi(
      "प्रिय {customer_name},",
      "बधाई हो! {project} में प्लॉट {plot_no} की रजिस्ट्री (रजिस्टर्ड डीड) आपको सौंप दी गई है।\n*रजिस्ट्री दिनांक:* {registry_date}",
      "डिफेंस गार्डन ग्रुप में अपना विश्वास रखने के लिए धन्यवाद। हम आपके सुखद भविष्य की कामना करते हैं।",
    ),
  ),
};
export const ACCOUNT_WHATSAPP_POLICY = Object.freeze({
  cash_excluded: false,
  allowed_modes: ["CASH", "BANK", "CHEQUE", "UPI", "NEFT", "RTGS", "IMPS", "TRANSFER"],
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
/** Fail closed for unknown or mixed payment modes; outgoing rows have a negative amount. */
export function isAccountWhatsAppPaymentEligible(data, eventName) {
  const mode = String(data.payment_mode ?? data.payment_type ?? "")
    .trim()
    .toUpperCase();
  const from = String(data.payment_from ?? "")
    .trim()
    .toUpperCase();
  if (
    !ACCOUNT_WHATSAPP_POLICY.allowed_modes.includes(mode) ||
    (mode !== "CASH" && /\bCASH\b/.test(from))
  )
    return false;
  if (String(data.status).trim().toLowerCase() !== "approved") return false;
  const chequeStatus = String(data.cheque_status ?? "").trim().toUpperCase();
  if (
    (mode === "CHEQUE" || chequeStatus) &&
    chequeStatus !== "CLEARED"
  )
    return false;
  const amount = Number(data.amount);
  return (
    Number.isFinite(amount) &&
    (eventName === "PAYMENT_SENT" ? amount < 0 : amount > 0)
  );
}
