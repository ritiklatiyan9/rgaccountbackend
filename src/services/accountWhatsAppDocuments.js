import { configuredPaymentReceipt, renderConfiguredPaymentReceiptPdf } from "./receiptPdf.js";
import QRCode from "qrcode";
import { buildVerifyUrl, ReceiptType } from "../utils/receiptToken.js";
import {
  accountWhatsAppError,
} from "./accountWhatsApp.spec.js";

export const ACCOUNT_WHATSAPP_DOCUMENT_EVENTS = Object.freeze([
  "PAYMENT_RECEIVED",
  "PAYMENT_SENT",
  "INSTALLMENT_RECEIVED",
]);
export const accountWhatsAppReceiptSample = (event) => ({
  full_name: "Rahul Sharma",
  site_name: "Defence Garden",
  member_code: "CLT-00123",
  plot_no: "A12",
  amount: event === "PAYMENT_SENT" ? -100000 : 100000,
  payment_mode: "BANK",
  payment_date: "2026-10-23",
  receipt_no: "ACK-100123",
  status: "approved",
  ...(event === "INSTALLMENT_RECEIVED"
    ? { installment_name: "Installment 2" }
    : {}),
});
export const accountWhatsAppReceiptFilename = (data) =>
  `payment-receipt-${String(data.receipt_no || "sample")
    .replace(/[^a-z0-9_-]/gi, "_")
    .slice(0, 100)}.pdf`;
/** Use the native receipt identity and recorded facts, as the print viewer does. */
export function accountWhatsAppReceiptVerifyUrl(event, data) {
  if (!ACCOUNT_WHATSAPP_DOCUMENT_EVENTS.includes(event)) return "";
  const module = event === "INSTALLMENT_RECEIVED" ? "plot_installment_payment" : "plot_payment";
  const sourceId = Number(data.source_id);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || data.receipt_module !== module) return "";
  return buildVerifyUrl({
    t: ReceiptType.PLOT,
    i: `${module}_${sourceId}`,
    a: Math.abs(Number(data.amount)),
    dr: event === "PAYMENT_SENT" ? "OUT" : "IN",
    d: data.payment_date || null,
    pm: data.payment_mode || data.payment_type || null,
    pn: data.full_name || null,
    pl: data.plot_no || null,
    sn: data.site_name || null,
    sy: data.site_city || null,
    ss: data.site_state || null,
  });
}
/** A customer copy rendered only from the canonical, policy-checked payment row. */
export async function renderAccountWhatsAppReceipt(
  event,
  data,
  { sample = false, design, qrDataUrl = "" } = {},
) {
  if (!ACCOUNT_WHATSAPP_DOCUMENT_EVENTS.includes(event))
    throw accountWhatsAppError("This module has no payment receipt attachment");
  if (
    !Number.isFinite(Number(data.amount)) ||
    !data.receipt_no ||
    !data.full_name ||
    !data.site_name
  )
    throw accountWhatsAppError(
      "The payment receipt is missing required transaction details",
      409,
    );
  const receipt = configuredPaymentReceipt(event, data, design);
  const verifyUrl = !sample && receipt.fields.qr && !qrDataUrl
    ? accountWhatsAppReceiptVerifyUrl(event, data) : "";
  const verificationQr = verifyUrl
    ? await QRCode.toDataURL(verifyUrl, { width: 300, margin: 1, errorCorrectionLevel: "M" })
    : qrDataUrl;
  return renderConfiguredPaymentReceiptPdf(receipt, data, { sample, qrDataUrl: verificationQr });
}
