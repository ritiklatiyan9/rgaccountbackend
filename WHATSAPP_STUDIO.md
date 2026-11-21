# Accountancy WhatsApp Studio

The Accountancy frontend exposes `/whatsapp-studio` to administrators and super administrators. Home, navigation and the Clients, KYC, Plot Payments, Installment Tracker and Plot Registry workspaces link to it. Settings, templates and activity belong to the selected project and organization.

## Activation

1. Deploy the Accountancy backend changes and install dependencies with `npm ci`.
2. With approval for the configured database, run `npm run migrate:account-whatsapp`. Migration 225 adds `account_whatsapp_templates`, `account_whatsapp_stage_settings` and `account_whatsapp_messages`. It records the migration, preserves financial records and starts every event disabled with no assigned template. Migration 246 (Hindi, see below) runs in the same command.
3. Configure the `WHATSAPP_*` variables in `.env.example` for the existing AWS End User Messaging Social sender. The Accountancy worker uses its own outbox; the Booking worker must never process these rows.
4. Restart the backend. In Studio, use **Use approved AWS template** to reuse an existing approved message, or create a new template and wait for Meta approval. Explicitly apply the selected version, then enable the event. A new approved version never replaces the current assignment automatically.

## Reuse an approved AWS template

Choose a template from the linked AWS business account and map each numbered variable to an event field. The approved registration template `dgg_registered_v2` uses customer name, project, then member ID; event field order must not be used as a substitute for this mapping. Import creates only a project/event reference in Accountancy. It never creates or edits a Meta template, enables sending or sends a message. Document support requires migration 226, which adds only a document-header flag and preserves existing assignments and sending settings.

Import supports BODY-only templates and a single DOCUMENT header with consecutive positional variables. Document headers attach a generated payment receipt for PAYMENT_RECEIVED, PAYMENT_SENT or INSTALLMENT_RECEIVED. Configure WHATSAPP_MEDIA_BUCKET to the existing private WhatsApp bucket in the sender AWS account and region; media uses the same sender credentials. Other header formats, buttons and footers remain unsupported. The seven payment variables can map to customer name, project, amount, ACK receipt number, payment date, payment mode and client registration (Member ID). The PDF uses the same canonical payment and is not sent when the record changes during PDF preparation. Admins can download a fictional sample without enabling the sender. A template stating KYC Pending is skipped on onboarding when the client's KYC is already verified.

Imported references use a namespaced local name; the original provider name is used for delivery. The worker checks the current AWS definition before sending. Changed content, language or category blocks sending until an operator unapplies the reference and reviews its mapping. Archiving or removing an imported reference preserves the shared AWS template and other software's use of it. Provider deletion of an Accountancy-owned template is blocked while another local reference uses its Meta ID.

The local preview command `npm run dev:studio-api` listens on `127.0.0.1:8000`. It does not apply migrations or start unrelated reminder schedulers. Local and hosted APIs may have different signing keys: preserve the existing frontend API URL until a normal sign-in against the selected backend is available. Do not mix tokens between environments.

## English and Hindi

Every module always sends its English message. A project can also send a Hindi message to the same client, as a second WhatsApp message right behind the English one.

- **Activation.** `npm run migrate:account-whatsapp` now also runs migration 246 (`246_account_whatsapp_hindi`), which adds `account_whatsapp_stage_settings.template_name_hi` and `account_whatsapp_messages.language`. It is additive and enables nothing. A server deployed before the migration keeps sending English exactly as before and shows no Hindi controls as usable.
- **Three things make Hindi send for a project.** (1) The project's **Message languages** switch in Studio is on (stored in `application_settings` key `account_whatsapp_hindi_v1`); (2) the module has an approved Hindi template applied under **Hindi message** in Manage event (`template_name_hi`); (3) the module is enabled with its English template applied. Remove any one and clients receive English only. Studio shows which enabled modules would skip Hindi.
- **Hindi templates are separate Meta templates** created in Studio with the Hindi language (named `dgg_acc_s<site>_<event>_hi_<id>`, language `hi`) and need their own Meta approval. The English slot only accepts English templates and the Hindi slot only Hindi ones. Payment modules need a PDF document header in Hindi too, so the receipt PDF is attached to both messages.
- **Delivery.** The worker sends English first, exactly as before. Hindi is attempted only after English reached the provider (sent or failed), so a message blocked by the non-cash policy, a changed installment or a client without a valid mobile number never produces a lone Hindi message. The Hindi attempt gets its own log row (`language = 'hi'`, dedupe key `<english key>#hi`, created already `SENDING` so no other worker can claim it) and succeeds or fails independently. Existing queue keys, the installment due-date and overdue checks, and the one-per-event rule are unchanged. A Hindi template that stops being approved never blocks pausing or editing the module; the Hindi row is logged as skipped.
- **Samples.** The sample action takes a `language` (`en` default or `hi`) and uses the saved applied template of that language, regardless of the project switch.
- **API.** `PUT /account-whatsapp/languages { site_id, hindi }` flips the project switch. `PUT /stages/:event` accepts `template_name_hi`. `POST /templates` accepts `language`. `GET /studio` returns `languages { hindi_ready, hindi_enabled }` and per module `default_body_hi`, `active_template_hi` and `settings.template_name_hi`.
- **Wording.** Default Hindi texts live in `ACCOUNT_WHATSAPP_EVENTS[event].body_hi` and `overdueTemplateBodyHi`; they mirror the English defaults field for field. A project's applied English text can differ from the default, so write its Hindi version in the Studio composer to match what that project's clients actually receive.

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

## Marketing campaigns and customer inbox

Studio now has **Campaigns** and **Inbox** tabs. Direct links use
`/whatsapp-studio?tab=campaigns` and `/whatsapp-studio?tab=inbox`. Both are
administrator-only and scoped to the authenticated organization. Campaigns are
independent from the accounting-event automations above.

Install the additive campaign/inbox schema with
`npm run migrate:account-whatsapp-outreach`. Production startup also checks these
two migrations. Installation creates no campaigns, recipients, subscriptions or
messages.

The campaign workflow is **Save draft → Attach PDF → Submit to Meta → Check
approval → Review audience → Send campaign**. Footer text is optional and is
omitted from the Meta definition when blank. The document is privately stored
and is delivered as `INVITATION.pdf`; normal campaign responses contain its
metadata only. PDF bytes are downloaded or uploaded to the provider separately.
The all-sites audience includes active, inactive and test sites in the same
organization. Each registration contributes one valid destination, preferring
WhatsApp, then primary mobile, then alternate mobile as a fallback. Normalized
phone numbers are deduplicated across sites, and blocked profiles and existing
marketing opt-outs are excluded. Preview counts describe number format, not a
promise that each number is registered with WhatsApp.

Only the explicit manual **Send campaign** action freezes and queues the
reviewed audience. It requires the current revision, permission confirmation,
typed `SEND` and an idempotency key. Meta approval never starts a campaign and
there is no date scheduler. The worker checks the live approved Marketing
DOCUMENT definition, rechecks opt-outs, uploads the static PDF once per cached
media period, and claims bounded batches. Pause stops unclaimed work. Ambiguous
sends require review and are never resent automatically; retrying an inbox
projection cannot send another message.

Inbox conversation lists and history use bounded cursor pagination. Reads have
message watermarks so newly arriving messages remain unread. Manual replies are
idempotent and require a customer-originated message within the actual 24-hour
reply window. AWS and Meta IDs are correlated using opaque callback IDs, and
out-of-order delivery/read receipts cannot downgrade a message. Received media
currently appears as a private filename/caption card; inbound media downloading
is not yet supported. Outgoing campaign PDFs use an authenticated download.

Incoming events can use either the signed SNS HTTPS route
`POST /account-whatsapp/webhook` or a private SNS-to-SQS subscription. Both paths
verify the SNS signature, topic allowlist and configured sender/account/region
before committing data. Sender/organization binding is explicit. STOP/START
updates both this inbox and the shared Booking marketing exclusions without
removing operator-created opt-outs.

For a local dashboard, the private queue avoids exposing localhost publicly:

```bash
npm run setup:account-whatsapp-inbox -- --organization-id 1 --sender-config ../../Bookings/sales-backend/.env --apply
```

This explicit setup preserves an existing SNS event destination, adds a private
encrypted queue with 14-day retention and a dead-letter queue, and writes only
routing settings to ignored `.env.whatsapp.local`. It sends no customer message.
The WABA supports one event destination, so an incompatible existing destination
is left untouched for review. No infrastructure is created on server startup.

`scripts/account-whatsapp-preview.mjs` serves only campaigns and inbox at
`127.0.0.1:8014`. It verifies the existing hosted Accounts session using the
same fixed-upstream session bridge as other local previews. The Vite plugin
starts this service when `VITE_ACCOUNT_WHATSAPP_API_URL` is configured to a
loopback HTTP origin. Existing event-automation requests keep their original API
destination. Sender credentials remain server-side in the existing sender
environment; `.env.whatsapp.local` holds queue/topic routing, not copied keys.
The preview starts the campaign worker only with
`ACCOUNT_WHATSAPP_CAMPAIGN_WORKER=true` and starts the inbound worker when a
private queue is configured. It starts no accounting reminders. While the local
service is closed, the private queue retains incoming events until it resumes.

New API families are `/account-whatsapp/campaigns` (drafts, documents, audience,
submission, status, manual send and pause) and `/account-whatsapp/inbox`
(conversations, history, read watermark, readiness and manual replies). Polling
does not submit templates or contact Meta; approval checks are explicit. New UI
chunks lazy-load and stop polling when hidden. Worker commands are
`worker:account-whatsapp-campaigns` and `worker:account-whatsapp-inbound`.
