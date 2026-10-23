# Accountancy WhatsApp Studio

The Accountancy frontend exposes `/whatsapp-studio` to administrators and super administrators. Home, navigation and the Clients, KYC, Plot Payments, Installment Tracker and Plot Registry workspaces link to it. Settings, templates and activity belong to the selected project and organization.

## Activation

1. Deploy the Accountancy backend changes and install dependencies with `npm ci`.
2. With approval for the configured database, run `npm run migrate:account-whatsapp`. Migration 225 adds `account_whatsapp_templates`, `account_whatsapp_stage_settings` and `account_whatsapp_messages`. It records the migration, preserves financial records and starts every event disabled with no assigned template.
3. Configure the `WHATSAPP_*` variables in `.env.example` for the existing AWS End User Messaging Social sender. The Accountancy worker uses its own outbox; the Booking worker must never process these rows.
4. Restart the backend. In Studio, use **Use approved AWS template** to reuse an existing approved message, or create a new template and wait for Meta approval. Explicitly apply the selected version, then enable the event. A new approved version never replaces the current assignment automatically.

## Reuse an approved AWS template

Choose a template from the linked AWS business account and map each numbered variable to an event field. The approved registration template `dgg_registered_v2` uses customer name, project, then member ID; event field order must not be used as a substitute for this mapping. Import creates only a project/event reference in Accountancy. It never creates or edits a Meta template, enables sending or sends a message. This enhancement requires no migration beyond migration 225.

Import currently supports BODY-only templates with consecutive positional variables. Document headers, buttons and footers require additional component support and cannot be imported through this flow. A template stating KYC Pending is skipped on onboarding when the client's KYC is already verified.

Imported references use a namespaced local name; the original provider name is used for delivery. The worker checks the current AWS definition before sending. Changed content, language or category blocks sending until an operator unapplies the reference and reviews its mapping. Archiving or removing an imported reference preserves the shared AWS template and other software's use of it. Provider deletion of an Accountancy-owned template is blocked while another local reference uses its Meta ID.

The local preview command `npm run dev:studio-api` listens on `127.0.0.1:8000`. It does not apply migrations or start unrelated reminder schedulers. Local and hosted APIs may have different signing keys: preserve the existing frontend API URL until a normal sign-in against the selected backend is available. Do not mix tokens between environments.

## Events and policy

| Event | Trigger |
| --- | --- |
| Client onboarded | New client registration committed |
| KYC verified | Verification or verified KYC reuse completed |
| Plot booked | A client booking becomes approved |
| Payment received | Approved non-cash plot receipt |
| Payment sent / refund | Approved non-cash outgoing plot payment |
| Installment received | Approved non-cash direct installment receipt |
| Installment due | Unpaid eligible installment at its selected lead time, in India time |
| Registry congratulations | Completed registered-deed handover with registry date and deed on file |

CASH, unknown modes, internal transfers, pending entries and uncleared cheques cannot produce transaction messages. The queue and worker both re-read canonical financial records. Cash receipts still reduce outstanding installment balances. NOC creation does not mean registry completion.

Event references are deduplicated per project. Existing clients and overdue installments are not backfilled. Queued events older than one day expire. Interrupted or ambiguous sends require operator review rather than automatic retry. Activity `SENT` means provider acceptance, not confirmed delivery. The sample action uses fictional values and an explicitly entered phone number.

Archive requires removing a template's assignment; restore does not reapply it. Deletion retains local history and rejects applied or currently sending versions. Meta approval may change a template's category.

## Verification

Run `npm run test:account-whatsapp` for isolated policy, controller-hook and PGlite database checks. These tests inject transport and never send customer messages or modify the configured database. The frontend tests are in `src/lib/accountWhatsAppStudio.test.mjs` and `src/pages/WhatsAppStudio.render.test.mjs` in `Accounts/rgaccount`.
