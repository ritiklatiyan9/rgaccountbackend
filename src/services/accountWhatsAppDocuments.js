import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import {
  ACCOUNT_WHATSAPP_EVENTS,
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
const fonts = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/fonts",
);
const clean = (value) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A customer copy rendered only from the canonical, policy-checked payment row. */
export async function renderAccountWhatsAppReceipt(
  event,
  data,
  { sample = false } = {},
) {
  if (!ACCOUNT_WHATSAPP_DOCUMENT_EVENTS.includes(event))
    throw accountWhatsAppError("This module has no payment receipt attachment");
  const spec = ACCOUNT_WHATSAPP_EVENTS[event];
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
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 44,
      info: {
        Title: `Payment receipt ${clean(data.receipt_no)}`,
        Author: "Defence Garden Group",
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.registerFont("Regular", path.join(fonts, "Figtree-Regular.ttf"));
    doc.registerFont("Bold", path.join(fonts, "Figtree-Bold.ttf"));
    const left = 44,
      width = 507;
    const text = (value, x, y, w, size = 10, bold = false, color = "#23372e") =>
      doc
        .font(bold ? "Bold" : "Regular")
        .fontSize(size)
        .fillColor(color)
        .text(clean(value), x, y, { width: w, height: 38, ellipsis: true });
    doc.roundedRect(left, 44, width, 100, 12).fill("#ecf7f0");
    text(
      "DEFENCE GARDEN GROUP",
      left + 20,
      63,
      width - 40,
      18,
      true,
      "#17633e",
    );
    text(data.site_name, left + 20, 92, width - 40, 11);
    text(
      sample ? "SAMPLE - FICTIONAL DETAILS" : "ACCOUNTANCY PAYMENT RECEIPT",
      left + 20,
      115,
      width - 40,
      8,
      true,
      "#547366",
    );
    text(
      event === "PAYMENT_SENT"
        ? "Payment / refund confirmation"
        : "Payment received",
      left,
      166,
      width,
      21,
      true,
    );
    text(`Receipt ${data.receipt_no}`, left, 198, width, 10, false, "#62746a");
    doc.roundedRect(left, 228, width, 88, 10).fill("#173f2c");
    text(
      event === "PAYMENT_SENT" ? "AMOUNT SENT" : "AMOUNT RECEIVED",
      left + 20,
      244,
      width - 40,
      9,
      true,
      "#c9e6d4",
    );
    text(
      spec.fields.amount.value(data),
      left + 20,
      266,
      width - 40,
      25,
      true,
      "#ffffff",
    );
    const rows = [
      ["Client", data.full_name],
      ["Project", data.site_name],
      ["Registration / Member ID", data.member_code],
      ["Plot", data.plot_no],
      ["Payment date", spec.fields.payment_date.value(data)],
      ["Payment mode", data.payment_mode],
      ...(data.installment_name
        ? [["Installment", data.installment_name]]
        : []),
    ];
    let y = 342;
    for (const [label, value] of rows) {
      const h = 46;
      text(label, left, y, 170, 9, false, "#6a7d71");
      text(clean(value) || "-", left + 182, y, 325, 10, true);
      doc
        .moveTo(left, y + h - 10)
        .lineTo(left + width, y + h - 10)
        .lineWidth(0.5)
        .strokeColor("#e3eae5")
        .stroke();
      y += h;
    }
    y += 12;
    doc
      .font("Regular")
      .fontSize(9)
      .fillColor("#62746a")
      .text(
        sample
          ? "Preview only. This sample does not acknowledge a real payment."
          : "This receipt acknowledges the approved transaction recorded above. Please quote the receipt number when contacting our office.",
        left,
        y,
        { width, lineGap: 4 },
      );
    doc
      .moveTo(left, 760)
      .lineTo(left + width, 760)
      .strokeColor("#d9e7dd")
      .stroke();
    text(
      "Defence Garden Group | Customer copy",
      left,
      773,
      width,
      8,
      false,
      "#6a7d71",
    );
    doc.end();
  });
}
