# Royal Hair admin-login build

## Render Environment Variables
Set these in the existing Render web service before deploying:
- `ADMIN_PASSWORD`: a long, unique admin password (recommend 20+ characters).
- `SESSION_SECRET`: a cryptographically random secret (at least 32 random bytes; use a different value from every other credential).

Generate a secret locally with:
`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

Keep existing variables unchanged, including `DATABASE_URL`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `WABA_ID`, `VERIFY_TOKEN`, `BITRIX_WEBHOOK_URL`, `GRAPH_API_VERSION`, and any other existing configuration. Do not put secrets in source files.

## Deployment
1. Save/export the current Render environment configuration securely.
2. Add `ADMIN_PASSWORD` and `SESSION_SECRET` in Render > service > Environment.
3. Deploy this ZIP's files to the existing app repository/service, preserving the project structure: `app.js`, `package.json`, `public/index.html`, `public/login.html`.
4. Confirm the app opens at `/login`, correct password opens dashboard, incorrect password is rejected, and protected `/api/*` routes return 401 when logged out.
5. Verify inbound/outbound WhatsApp and Bitrix sync. Meta `/webhook` remains reachable for platform callbacks.
6. Test logout, then redeploy/rollback if any integration fails.

## Notes
- This implements one shared admin password, not individual users.
- Session lifetime is 12 hours. Cookie is HttpOnly and SameSite=Strict, with Secure enabled when `NODE_ENV=production`.
- The app still needs its existing Meta webhook verification configured. Do not disable webhook validation.
- Changing the Render hostname is a separate Render setting; this package secures the app but does not rename the `onrender.com` hostname.
- The app has not been live-tested against your Render, Meta or Bitrix accounts. Run the checks above before using it with live leads.
