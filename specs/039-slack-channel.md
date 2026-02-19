# Spec 039: Slack Channel Integration (Cookie-Based Auth)

## Goal
Add Slack as a first-class communication channel using **cookie-based authentication** — no Slack App to install, no admin approval needed. Works with any workspace including company Slack. DeeDee should be able to read and reply in Slack as the user, and support querying conversation history (e.g., "What did we discuss with X about Y?").

## Background
The user explicitly wants:
1. **Zero installation** — no Slack App, no bot, no OAuth setup. Cookie-based auth only.
2. **Company Slack support** — works without workspace admin approval.
3. **Easy login via UI** — login flow through the Interfaces Settings page in the web dashboard.
4. **Conversation search** — "What did we talk about with @person about topic?".

## Architecture

### Authentication: Cookie-Based (`xoxc-` + `xoxd-`)
When you log into Slack in a browser, Slack issues two tokens:
- **`xoxc-*`** — API token (used as `Authorization: Bearer` header).
- **`xoxd-*`** — Cookie token (sent as `d=xoxd-*` cookie).

Both are required together. This is the same auth your browser uses — no app installation needed.

**How it works:**
1. User opens DeeDee Settings → Interfaces → Slack.
2. Clicks "Connect Slack" → Opens an embedded Slack login form (or instructions).
3. User logs into their Slack workspace.
4. DeeDee extracts `xoxc-` and `xoxd-` tokens from the login session.
5. Tokens are stored encrypted in the agent's data directory.
6. DeeDee uses these tokens to call Slack's Web API as the user.

### Token Extraction Methods

**Method A: Manual Paste (Simple, Reliable)**
The UI provides step-by-step instructions:
1. Open Slack in your browser.
2. Open DevTools → Application → Cookies → find `d` cookie (starts with `xoxd-`).
3. Open DevTools → Network → filter XHR → find any Slack API call → copy `token` from request body (starts with `xoxc-`).
4. Paste both into the DeeDee settings form.

**Method B: Browser-Assisted Login (Better UX, Phase 2)**
Use the Browser MCP to automate the login:
1. User clicks "Connect Slack" in Settings.
2. DeeDee opens Playwright to `https://app.slack.com`.
3. User logs in (including 2FA if needed).
4. DeeDee extracts cookies from the browser context automatically.
5. Tokens stored — user never sees raw tokens.

We start with Method A, add Method B as an enhancement.

### Real-Time Messages: Slack RTM-like Polling
Since we don't have Socket Mode (requires an app), we use **polling** via `conversations.history` API:
- Poll every 5 seconds for new messages in subscribed channels/DMs.
- Track `last_read_ts` per channel to only fetch new messages.
- Efficient: Slack API rate limit is generous for read operations (~50 req/min tier 3).

Alternative: Slack's **WebSocket RTM** connection (legacy, but works with user tokens). This gives real-time events like Socket Mode but doesn't require an app. Use `rtm.connect` API.

### Message Flow

```
Slack RTM/Poll ──→ SlackService.onMessage() ──→ POST /chat (Agent) ──→ Agent Reply
                                                                           │
                                                              SlackService.send()
                                                                           │
                                                               Slack Web API
                                                           (chat.postMessage)
                                                          (using xoxc- token)
```

### Channel Class: `SlackService`
Lives in `apps/interfaces/src/slack.js`. Follows the same pattern as `TelegramService` and `WhatsAppService`.

```
apps/interfaces/src/
├── server.js          # Add Slack init alongside Telegram/WhatsApp
├── slack.js           # NEW — SlackService
└── ...
```

## Features & Tools

### 1. Listen & Reply (Core)
- Listen to DMs and mentions in channels via RTM WebSocket or polling.
- Reply in the same channel/thread using `chat.postMessage`.
- Support threads — if the incoming message is in a thread, reply in the same thread.
- **Mention gating**: In channels, only respond when `@`-mentioned. In DMs, always respond.

### 2. Conversation Search Tool: `searchSlack`
Leverages Slack's powerful `search.messages` API (available with user tokens).

```javascript
{
  name: "searchSlack",
  description: "Search Slack messages. Use for questions like 'What did we discuss with X about Y?' Returns matching messages with context. Supports Slack search syntax.",
  parameters: {
    type: "OBJECT",
    properties: {
      query: { type: "STRING", description: "Search query. Supports: from:user, in:#channel, before:date, after:date, has:link, etc." },
      limit: { type: "NUMBER", description: "Max results (default 10)" }
    },
    required: ["query"]
  }
}
```

### 3. Channel History Tool: `readSlackHistory`
```javascript
{
  name: "readSlackHistory",
  description: "Read recent messages from a Slack channel or DM.",
  parameters: {
    type: "OBJECT",
    properties: {
      channel: { type: "STRING", description: "Channel name (e.g., '#general') or user name" },
      limit: { type: "NUMBER", description: "Number of messages (default 20)" }
    },
    required: ["channel"]
  }
}
```

### 4. Send Slack Message Tool: `sendSlackMessage`
```javascript
{
  name: "sendSlackMessage",
  description: "Send a message to a Slack channel or user.",
  parameters: {
    type: "OBJECT",
    properties: {
      to: { type: "STRING", description: "Channel name or user name" },
      content: { type: "STRING" },
      thread_ts: { type: "STRING", description: "Optional thread timestamp to reply in a thread" }
    },
    required: ["to", "content"]
  }
}
```

## Implementation Plan

### Phase 1: Core SlackService + Manual Token Setup

1. **Create `apps/interfaces/src/slack.js`**:
   - `SlackService` class with `start()`, `stop()`, `send()`.
   - HTTP client using `xoxc-`/`xoxd-` tokens for Slack Web API.
   - RTM WebSocket connection via `rtm.connect` for real-time events.
   - Fallback to polling if RTM fails.
   - Event handler for `message` events → forward to Agent.
   - DM vs Channel logic (always respond in DM, mention-only in channels).
   - Thread awareness.
   - User ID → name resolution cache (`users.info`).

2. **Token storage**:
   - Stored in `data/slack-credentials.json` (encrypted at rest with `DEEDEE_API_TOKEN` as key).
   - API endpoints: `POST /slack/credentials` (save), `GET /slack/status`.

3. **Register in `server.js`**: Add Slack alongside Telegram/WhatsApp init.

4. **Token refresh monitoring**: Detect token expiration (Slack returns `token_revoked`) and notify user via existing channels (Telegram/WhatsApp: "Your Slack token expired, please re-login").

### Phase 2: Agent Tools

1. **Add tools to `tools-definition.js`**: `searchSlack`, `readSlackHistory`, `sendSlackMessage`.
2. **Create `apps/agent/src/executors/slack.js`** — `SlackExecutor`:
   - `searchSlack` → calls Interfaces `/slack/search` endpoint.
   - `readSlackHistory` → calls Interfaces `/slack/history` endpoint.
   - `sendSlackMessage` → calls Interfaces `/send` endpoint (unified).
3. **Register executor** in `tool-executor.js`.

### Phase 3: Settings UI (Login Flow)

1. **Add "Slack" tab** to Interfaces Settings page (`apps/web/src/app/settings/page.js`).
2. **Connection card** showing:
   - Status: Connected/Disconnected.
   - Workspace name (from `auth.test` API response).
   - User name.
   - Token age / last refreshed.
3. **Manual login form**:
   - Two text fields: "API Token (xoxc-...)" and "Cookie Token (xoxd-...)".
   - Step-by-step instructions with screenshots for extracting from browser DevTools.
   - "Test Connection" button → calls `auth.test` → shows success/failure.
   - "Save & Connect" button.
4. **Disconnect button**: Clears stored credentials, disconnects RTM.

### Phase 4: Browser-Assisted Login (Enhancement)

1. Use the Browser MCP to navigate to `https://app.slack.com`.
2. User logs in manually (DeeDee streams the browser view via existing CDP relay).
3. After login, DeeDee extracts cookies from Playwright's browser context.
4. Auto-saves tokens — completely seamless.
5. This is a stretch goal that depends on spec 041 (Browser V2) being implemented first.

### Phase 5: Smart Features

1. **Autopilot for Slack DMs**: Support Slack DMs in the Autopilot draft system.
2. **Reaction support**: Add emoji reactions as a lightweight response option.
3. **File sharing**: Support reading shared files/images from Slack messages.
4. **Channel subscription**: UI to select which channels DeeDee monitors.

## Security
- Tokens stored encrypted on disk (AES-256 with `DEEDEE_API_TOKEN` as key).
- Never exposed to the web client (Server Actions only).
- All Interfaces endpoints protected by existing `authMiddleware`.
- Token expiration monitoring with user notification.

## Token Lifecycle

| Event | Action |
|---|---|
| User pastes tokens in UI | Validate via `auth.test` → encrypt → save to disk → start RTM |
| Token works | Normal operation |
| Token expires (~30 days) | Slack returns `token_revoked` → disconnect → notify user via Telegram/WhatsApp |
| User re-logs in | New tokens saved → reconnect |

## Files Changed

| File | Action | Description |
|---|---|---|
| `apps/interfaces/src/slack.js` | NEW | SlackService class (RTM + Web API) |
| `apps/interfaces/src/server.js` | MODIFY | Add Slack init, credential endpoints |
| `apps/interfaces/package.json` | MODIFY | Add `@slack/web-api` dependency |
| `apps/agent/src/executors/slack.js` | NEW | SlackExecutor |
| `apps/agent/src/tools-definition.js` | MODIFY | Add Slack tools |
| `apps/agent/src/tool-executor.js` | MODIFY | Register SlackExecutor |
| `apps/web/src/app/settings/page.js` | MODIFY | Add Slack settings tab |
| `apps/web/src/components/SlackSettings.js` | NEW | Slack credential form + status |

## Testing
- **Unit**: Mock Slack API calls; test search result formatting, thread detection, mention parsing.
- **Integration**: End-to-end: save tokens → RTM connects → receive DM → agent replies.
- **Manual**: Paste company Slack tokens → verify DM receive/reply + search "from:coworker about project".
