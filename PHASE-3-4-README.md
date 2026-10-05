# Royal Hair Command Center — Phase 3 + 4 + Automatic Follow-ups + Explicit Language Mapping

This build includes:
- Phase 3 Intelligence: analytics, language intelligence and AI assistant.
- Phase 4 Scale: multi-agent support, assignments, roles/permissions and agent performance.
- Automatic Follow-up 1 and Follow-up 2 processing.
- 24-hour messaging-window protection for free-form messages.
- **Explicit language × follow-up template mapping**.

## Multilingual follow-up behavior
Follow-up automation no longer guesses or falls back to another language.
Each lead uses its Bitrix `language` value, normalized to the supported language key, and the exact approved Meta template mapped for that language and follow-up number.

Example:
- English + Follow-up 1 -> mapped English Follow-up 1 template
- Italian + Follow-up 1 -> mapped Italian Follow-up 1 template
- Spanish + Follow-up 2 -> mapped Spanish Follow-up 2 template

If a language/follow-up mapping is missing, or the mapped template is not approved, the system does **not send**. It logs `followup_template_missing` and leaves the lead available for attention.

## Setup
1. Deploy the files without changing your existing Render environment variables or PostgreSQL database.
2. Open **Settings -> Follow-up sequence**.
3. Set Follow-up 1 and Follow-up 2 timing.
4. Under **Language × template mapping**, select the exact approved Meta template for each language and each follow-up.
5. Click **Save sequence & mappings**.

Do not select a generic/free-message template. The automation requires an approved WhatsApp template.


UI update: Settings is now accessible from a visible top-bar button and the left sidebar is independently scrollable. Follow-up stages are split into "Pending for Follow-up 1" and "Pending for Follow-up 2". Existing leads using the old "Pending for Follow-up" stage are migrated on startup based on whether Follow-up 1 has already been sent.
