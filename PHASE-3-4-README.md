# Royal Hair Command Center — Phase 3 + Phase 4

## Phase 3 — Intelligence
- Analytics dashboard: lead funnel, response rate, photo rate, average response time, message activity and stage distribution.
- Language intelligence: conversation language detection for common Royal Hair lead languages; detected language is stored on contacts/leads.
- AI Assistant: conversation summary, intent, risk/escalation, next action and suggested reply. Suggestions are never sent automatically.
- Optional OpenAI integration via `OPENAI_API_KEY` and `OPENAI_MODEL`. Without a key, the assistant uses a safe rule-based fallback.

## Phase 4 — Scale
- Multi-agent team records.
- Lead/conversation assignment and reassignment.
- Roles and permission definitions: Admin, Manager, Lead Qualification Agent, Viewer.
- Agent performance metrics: assigned leads, outbound messages, photos and conversion rate.
- Browser-level agent selection is stored in localStorage and sent as `X-Agent-Id` for operational attribution.
- Audit records for team/assignment changes.

## Render
Existing environment variables remain valid. Optional:
- `OPENAI_API_KEY` — add an API key to enable model-powered AI assistance.
- `OPENAI_MODEL` — defaults to `gpt-6-luna`.

Do not put the OpenAI key in frontend code. It must remain a Render environment variable.

## Important
This build adds the intelligence/team layer without changing the existing WhatsApp webhook, Bitrix, follow-up, broadcast or Shared Inbox workflows. Role definitions and permission checks are active for team management and lead assignment; a full login/authentication gate can be enabled as a later security layer once the team's identity provider/credentials are decided.
