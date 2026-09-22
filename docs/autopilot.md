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
- **WhatsApp IDs**: WhatsApp gives contacts a WhatsApp ID (LID) next to their phone number. A person record holds the phone number and, once linked, the WhatsApp ID (`identifiers.whatsapp_lid`); lookups match either one exactly. "Sync WhatsApp" on the People page and the nightly maintenance job link the two from the WhatsApp contact list. There is no digit-suffix guessing: a WhatsApp ID's digits are unrelated to the phone number. A contact known only by its WhatsApp ID keeps those digits as its phone and in `identifiers.whatsapp_lid`; `sendMessage` and the greetings send to it at `<id>@lid`, because `<id>@s.whatsapp.net` would be some other number.
- **Safety**: Function calling is disabled for drafts to prevent accidental command execution.

## Greetings

The Greetings tab runs the `partner_good_morning` (07:00, plus up to 75 minutes) and `partner_good_night` (22:30, plus up to 45 minutes) system jobs. They write one or two lines to one person from the owner's own WhatsApp, in the owner's style, and follow that person's saved style from the Style tab when there is one. The job skips a morning when the owner already wrote that day, and a night when the owner wrote in the last hour. The model declines when the chat shows an argument or bad news.

- **Who**: picked from People first, then WhatsApp contacts. Stored in the `partner_greeting` agent setting (`contact`, `name`), never in code. Picking a different person sets delivery to `dry_run`, so a wrong click can't send as the owner. A contact saved as the bare digits of a known WhatsApp ID is greeted at `<id>@lid`.
- **Delivery** (`mode`): every mode also sends the owner a note, through the delivery ledger, from Deedee's number (WhatsApp; Telegram when no owner phone is set).
  - `send`: the greeting goes out. If WhatsApp refuses it, the note says so; it never claims a send that failed.
  - `review`: the draft lands in Drafts (source `partner_greeting`). Approving it sends it. A morning draft expires after 3 hours, a night draft after 2; the note gives that window in hours, and the ledger drops the note if it can't deliver it in time. An expired draft drops out of the list and cannot be approved. A newer greeting draft for the same chat replaces an older one. Approving refuses (409) when the owner wrote to that chat after the draft was made, and a refused send leaves the draft approvable.
  - `dry_run`: nothing reaches the partner. The global `communication_dry_run` switch forces this mode, and the tab says so. The older `dryRun: true` still means dry run.
- **Together until** (`pausedUntil`, a date): both greetings skip through that day; the next morning's greeting runs again. Paused days pass without a note.
- **Schedule**: the tab shows both job switches. They start off; the owner turns them on.
- **Changes during the wait**: a scheduled run waits a random few minutes, then reads the setting again. A pause, mode or person saved during the wait applies to that run, and a job switched off during the wait sends nothing. A manual run of a switched-off job still runs.
- **Held back by code**: a draft with a link, a phone number, more than 3 lines or more than 280 characters never goes out. The owner gets the draft and the reason. The saved style and the partner's messages both reach the prompt, so this is the last guard on what goes out as the owner.

Greeting drafts never count as the pending autopilot draft of their chat, so they don't feed Active Learning.

## Usage
1. **Enable**: Go to `/autopilot` -> Settings Tab -> Select Contact -> "Assisted".
2. **Train**: Go to `/autopilot` -> Style Tab, search for the contact, then click "Analyze History" (or edit manually). A WhatsApp contact that isn't in People yet is added to People when picked, since a contact's style is stored on its person record. A contact already in People, by phone number or WhatsApp ID, opens that person instead of adding a second one.
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
