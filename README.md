# Royal Hair Istanbul WhatsApp Dashboard

This build extends the existing Express + WhatsApp Cloud API + Bitrix dashboard.

## Included

- Lead Manager with Contacted, Pending for Follow-up, Follow-up Done, Final Reminder, Waiting for Response, Photo Received and Junk stages.
- Automatic follow-up due-date scheduling:
  - Follow-up 1: 1 day after initial contact
  - Follow-up 2: 3 days after Follow-up 1
  - Final Reminder: 2 days after Follow-up 2
  - Timing is configurable in Settings.
- Stage history, counters, search, language/date filters, select-all, bulk stage changes.
- Approved Meta template sender with:
  - Fixed image header support
  - Template variables
  - Approved button text display
  - Quick-reply payload support
  - Automatic per-language template selection for multi-language audiences.
- Bitrix New-stage queue with date/language filtering and 5-second new-lead notification.
- Bitrix message sending moves a successfully contacted lead into the Lead Manager.
- CSV import with labels and label-based broadcasts.
- Stage-based and label-based broadcasts.
- WhatsApp webhook status tracking with WAMID, Sent/Delivered/Read/Failed.
- Shared Inbox with incoming media display and outbound media attachment.
- Dashboard pipeline statistics.
- Connected-number selector UI for future Coexistence/multi-number setup.
- JSON persistence so the app works without adding another database dependency.

## Environment variables

Set these in Render:

- `VERIFY_TOKEN`
- `WHATSAPP_TOKEN`
- `PHONE_NUMBER_ID`
- `WABA_ID`
- `BITRIX_WEBHOOK_URL`
- `GRAPH_API_VERSION` (optional; defaults to `v23.0`)
- `CONNECTED_WHATSAPP_NUMBER` (optional, display only)

Do not commit actual tokens to Git.

## Meta webhook

Callback URL:

`https://YOUR-RENDER-DOMAIN/webhook`

Verify token must equal the value in `VERIFY_TOKEN`.

Subscribe to the WhatsApp Business Account webhook and enable message/status events.

## Template media

For every approved template whose Meta definition contains an IMAGE header, open **Templates** and save a public HTTPS image URL for that exact template/language.

Follow-up templates without an IMAGE header do not receive media.

## Persistence

The app creates `data/database.json` automatically.

Render's normal filesystem can be ephemeral across redeploys/restarts. For production, attach a persistent disk to the service or migrate the data layer to PostgreSQL/Supabase. The application logic is intentionally kept behind simple data collections so that migration can be done later.

## Deploy

Keep:

- `app.js`
- `package.json`
- `public/index.html`

in the repository root.

Render start command:

`npm start`
