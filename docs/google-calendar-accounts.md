# Google Calendar accounts

Calendar settings support several OAuth-connected Google accounts per organization. Each account owns its tokens and ERP event mappings. Adding a different email leaves existing accounts connected; reconnecting the same email updates its existing connection and retains remote event IDs.

Apply `npm run migrate:google-calendar-accounts` after the Calendar and event reminder migrations. Migration 200 associates existing event mappings with the original connection before removing the organization-only uniqueness constraint. It preserves existing connection records and event IDs and sets the legacy attendee toggle to false.

`GET /settings/google-calendar/status` returns `connections` with account IDs, email addresses and connection status. It returns no tokens. Connect prompts for account selection; passing `connection_id` supplies a reconnect hint for an account in the same organization. Disconnect and sync accept `{ connection_id }`; omitting it syncs all accounts, while an ambiguous disconnect is rejected.

Event writes always use empty attendees and `sendUpdates: none`. The invitation settings and recipient-list routes have been removed. Legacy invitation-list records are retained for backups but no longer supply calendar attendees or reminder recipients. Event-level reminder preferences continue to control reminder recipients.

One account's token failure does not prevent delivery to other accounts. Its connection is marked for reauthorization, while calendar summaries report failures or unsynced accounts rather than selecting an arbitrary mapping.

Deploy the backend changes to the host named by `GOOGLE_REDIRECT_URI` before connecting additional accounts. The registered hosted callback can return to the configured frontend or the local settings app at `http://127.0.0.1:5174` / `http://localhost:5174`. Other return origins are rejected.

Local Calendar OAuth must use the same Google client and calendar encryption key as its hosted callback. OAuth state normalizes key whitespace just as the token cipher does; existing ten-minute signed states remain valid during the update.

Double-clicking a day in the dashboard or compliance calendar opens the add-event form for that date. `POST /compliance/items` accepts `repeat_monthly: true` and an optional `repeat_until`. The server creates a monthly compliance template and separate obligations, preserving the title, time, priority and reminders. The first year's dates are created atomically; the hourly scheduler extends the schedule without duplicates. Short months clamp to their last day. Apply `npm run migrate:calendar-repeat` before starting this version. The resulting schedule can be managed through Compliance templates.
