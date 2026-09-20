# Shared Receipt Design Studio

Receipt settings use the app-wide `receipt_design_v1` key with a version 2 value. Every site reads the same setting. The four payment modes retain their OM ASSOCIATES formats. `modules[module][mode]` contains explicit variations; absent entries inherit the shared mode. New sites inherit automatically.

The one-time `node scripts/promote-receipt-design.mjs --apply` activation backs up previous settings under `outputs/receipt-studio`, then copies OM ASSOCIATES to the global setting and existing site settings. The site copies allow the previous hosted version to show the same initial formats during rollout. Rerunning the script preserves an existing global design.

`GET /receipts/records/:module/:id` reads the native transaction behind a receipt, with module permissions and site access checked before returning data. `transactionReceipt.js` maps that record to receipt fields. `receiptDesigner.js` prepares signatures, QR and history and renders all previews, individual prints, and batches. Mirrored ledger entries retain their source module and receipt number.

The studio supports shared/module designs, editable labels and punctuation, hidden fields, additional recorded field keys, and a blank canvas with text, bound fields, images, rules, rectangles, QR and signatures. Canvas positions are millimetres. Text elements support `{{field_key}}`. Samples never replace recorded transaction values. Undo and redo apply before saving; saving updates all sites. Module variations can return to inheritance with **Use shared design**.

For local development, run `node scripts/dev-api.mjs` from the backend directory. It listens on `127.0.0.1:3000` without background schedulers. The frontend's ignored `.env.development.local` points to this API; production builds keep the hosted API configured in `.env.local`. Deploy both repositories together for the hosted application to use global saves and native receipt sources.

Validation:

- Frontend: `npm run test:receipts`, `npm run build`.
- Backend: `npm run test:receipts`.
- Read-only database smoke check: `node scripts/check-receipt-studio.mjs`.

The original/duplicate print audit remains independent of editable display labels. Canvas overflow is checked before printing to prevent clipped content.
