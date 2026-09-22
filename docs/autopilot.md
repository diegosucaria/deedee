# Autopilot (Assisted Mode)

## Overview
Autopilot allows DeeDee to assist in personal messaging by drafting replies in your style. It is designed to be a "Human-in-the-loop" system, prioritizing safety and user control.

## Architecture
- **Interception**: Messages from "Assisted" contacts are intercepted in `apps/agent/src/agent.js` *after* Watchers but *before* standard routing.
- **Impersonation**: `ImpersonationService` uses the last 20 messages of chat history to match tone/style via LLM.
- **Multi-Message Support**: The agent can now draft multiple sequential messages (separated by `[SPLIT]`) to mimic natural human texting patterns.
- **Autonomous Mode**: trusted contacts can be set to "Fully Autonomous", where the agent sends replies immediately without manual approval.
- **Active Learning**: When you edit a draft, the agent learns from the diff between its draft and your final message to improve future attempts.
- **Storage**: Drafts are stored in the `autopilot_drafts` table.
- **Style Learning**: 
  - `ImpersonationService` can analyze global message history (last 500 messages) to generate a "Style Profile".
  - This profile is stored in `agent_settings` (key: `user_style_profile`) and prepended to the system prompt during draft generation.
- **Guardrails**:
  - The system checks the contact's `relationship` field (e.g., "Boss", "Friend", "Wife").
  - **Professional** relationships enforce formal tone and ban slang.
  - **Personal** relationships allow casual tone and slang.
  - This constraint is appended at runtime to override any ambiguous learned style.
- **WhatsApp IDs**: WhatsApp gives contacts a WhatsApp ID (LID) next to their phone number. A person record holds the phone number and, once linked, the WhatsApp ID (`identifiers.whatsapp_lid`); lookups match either one exactly. "Sync WhatsApp" on the People page and the nightly maintenance job link the two from the WhatsApp contact list. There is no digit-suffix guessing: a WhatsApp ID's digits are unrelated to the phone number.
- **Safety**: Function calling is disabled for drafts to prevent accidental command execution.

## Greetings

The Greetings tab runs the `partner_good_morning` (07:00, plus up to 75 minutes) and `partner_good_night` (22:30, plus up to 45 minutes) system jobs. They write one or two lines to one person from the owner's own WhatsApp, in the owner's style, and follow that person's saved style from the Style tab when there is one. The job skips a morning when the owner already wrote that day, and a night when the owner wrote in the last hour. The model declines when the chat shows an argument or bad news.

- **Who**: picked from People first, then WhatsApp contacts. Stored in the `partner_greeting` agent setting (`contact`, `name`), never in code.
- **Delivery** (`mode`): every mode also sends the owner a WhatsApp note, through the delivery ledger, from Deedee's number.
  - `send`: the greeting goes out.
  - `review`: the draft lands in Drafts (source `partner_greeting`). Approving it sends it. A morning draft expires after 3 hours, a night draft after 2; an expired draft drops out of the list and cannot be approved.
  - `dry_run`: nothing reaches the partner. The global `communication_dry_run` switch forces this mode. The older `dryRun: true` still means dry run.
- **Together until** (`pausedUntil`, a date): both greetings skip through that day; the next morning's greeting runs again.
- **Schedule**: the tab shows both job switches. They start off; the owner turns them on.

Greeting drafts never count as the pending autopilot draft of their chat, so they don't feed Active Learning.

## Usage
1. **Enable**: Go to `/autopilot` -> Settings Tab -> Select Contact -> "Assisted".
2. **Train**: Go to `/autopilot` -> Style Tab, search for the contact, then click "Analyze History" (or edit manually). A WhatsApp contact that isn't in People yet is added to People when picked, since a contact's style is stored on its person record.
3. **Review**: When a message arrives, check the Drafts Tab.
3. **Approve/Edit/Reject**: Use the UI to manage the draft.

## API Endpoints
Endpoints are exposed via the API Gateway under `/v1/autopilot` (proxied to Agent).

- **Drafts**
  - `GET /v1/autopilot/drafts`
  - `POST /v1/autopilot/drafts/:id/approve`
  - `DELETE /v1/autopilot/drafts/:id` (Delete)
  - `PUT /v1/autopilot/drafts/:id` (Edit)
- **Settings**
  - `GET /v1/autopilot/settings`
  - `POST /v1/autopilot/settings/:id` (Update Status & Duration)
- **Style**
  - `GET /v1/autopilot/style` (Global)
  - `POST /v1/autopilot/style` (Save Global)
  - `POST /v1/autopilot/style/analyze` (Analyze Global)
  - `GET /v1/autopilot/style/:id` (Contact)
  - `POST /v1/autopilot/style/:id` (Save Contact)
  - `POST /v1/autopilot/style/:id/analyze` (Analyze Contact)
