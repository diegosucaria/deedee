# Autopilot (Assisted Mode)

## Overview
Autopilot allows DeeDee to assist in personal messaging by drafting replies in your style. It is designed to be a "Human-in-the-loop" system, prioritizing safety and user control.

## Architecture
- **Interception**: Messages from "Assisted" contacts are intercepted in `apps/agent/src/agent.js` *after* Watchers but *before* standard routing.
- **Impersonation**: `ImpersonationService` uses the last 20 messages of chat history to match tone/style via LLM.
- **Storage**: Drafts are stored in the `autopilot_drafts` table.
- **Style Learning**: 
  - `ImpersonationService` can analyze global message history (last 500 messages) to generate a "Style Profile".
  - This profile is stored in `agent_settings` (key: `user_style_profile`) and prepended to the system prompt during draft generation.
- **Safety**: Function calling is disabled for drafts to prevent accidental command execution.

## Usage
1. **Enable**: Go to `/autopilot` -> Settings Tab -> Select Contact -> "Assisted".
2. **Train**: Go to `/autopilot` -> Style Tab -> Click "Analyze History" (or edit manually).
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
