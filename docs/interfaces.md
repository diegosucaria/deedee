# Intefaces & Channels

Deedee communicates with you through various "Interfaces". The main `apps/interfaces` service handles these connections.

> Outbound owner notifications (reminders, job output, alerts, questions) go through the delivery ledger, which retries and falls back between WhatsApp and Telegram. See [notifications.md](./notifications.md).

## 📱 WhatsApp

Deedee uses [Baileys](https://github.com/WhiskeySockets/Baileys) to connect to WhatsApp Multi-Device.

### Setup
1.  **Enable**: The service is enabled by default, but starts in **Standby Mode**.
2.  **Environment Variables**:
    -   `ALLOWED_WHATSAPP_NUMBERS`: Comma-separated list of phone numbers (with country code, no `+`) allowed to talk to the bot.
        -   Example: `ALLOWED_WHATSAPP_NUMBERS=15550123456,15550987654`
        -   **Security**: If left empty, the bot **IGNORES ALL MESSAGES** (Secure by Default). You *must* set this to enable access.

3.  **Connection (Dual Identity)**:
    Deedee now supports two simultaneous WhatsApp sessions:
    
    *   **Assistant Identity**: This is Deedee's own number. Use this for the bot to reply to you as itself.
    *   **User Identity (Impersonation)**: This is *your* number (linked as a Companion Device). Use this if you want Deedee to send messages *as you* (e.g., replying to others on your behalf).

    **To Connect:**
    -   Go to **Interfaces** page independently.
    -   You will see two cards: "Assistant Identity" and "User Identity".
    -   Click **Start Session** on the one you want to link.
    -   Scan the QR Code with the respective WhatsApp account (Linked Devices).

4.  **Status**:
    -   The interface panel shows the status of both sessions.
    -   Session data is stored in `data/baileys_auth_assistant` and `data/baileys_auth_user`.

### Features
-   **Dual Session Routing**: The agent automatically routes messages to the correct session based on the tool usage (`session: 'assistant'` vs `'user'`).
-   **Text**: Send/Receive text messages.
-   **Audio**: Receive voice notes (Agent transcribes them). Send voice replies (Agent uses TTS).
-   **Images**: Receive images (Agent analyzes them). Send generated images.
-   **Security**: Ignores messages from unknown numbers if `ALLOWED_WHATSAPP_NUMBERS` is set.

---

## ✈️ Telegram

Deedee connects via the standard Telegram Bot API (Long Polling).

### Setup
1.  **Create Bot**: Use [@BotFather](https://t.me/BotFather) to create a bot and get a token.
2.  **Environment Variables**:
    -   `TELEGRAM_TOKEN`: Your HTTP API Token.
    -   `ALLOWED_TELEGRAM_IDS`: Comma-separated list of User IDs allowed to talk to the bot.
        -   Get your ID via [@userinfobot](https://t.me/userinfobot).
        -   Example: `ALLOWED_TELEGRAM_IDS=123456789,987654321`

### Features
-   **Audio**: Full support for voice notes (Ogg/Opus).
-   **Images**: Send a photo with an optional caption. The agent receives the largest available size as `inlineData` and can route it to tools like `add_garment`, `analyze_outfit_photo`, `add_vinyl`, etc. based on the caption.
-   **Commands**:
    -   `/stop`: Instantly kills any running agent processing loop.
    -   `/clear`: Clears conversation history (Context).

---

## 💬 Slack

Deedee reads your Slack workspaces using browser session tokens (xoxc/xoxd). This is a "cookie-based" integration that supports connecting **multiple workspaces** simultaneously.

### Setup
1. Open Slack in your browser (not the desktop app).
2. Get the `xoxc-` token from the browser console:
   ```js
   JSON.parse(localStorage.localConfig_v2).teams[Object.keys(JSON.parse(localStorage.localConfig_v2).teams)[0]].token
   ```
3. Get the `xoxd-` cookie from DevTools → Application → Cookies.
4. Go to **Settings → Slack** in the web UI. 
5. Click **Connect New Workspace**, paste both tokens, give the workspace a name (e.g., "Work", "Community"), and click **Connect**.
6. Repeat for as many workspaces as you need. Each connection has its own independent settings card.

### Features
- **Passive Mode**: Incoming Slack messages do NOT trigger the agent. No auto-title, no session creation, no DB storage. Watchers still fire.
- **Listening Toggle**: You can completely mute incoming Slack messages *per workspace* via the UI toggle (`POST /slack/listening`). When muted, even watchers won't fire and logs will be quiet.
- **Search**: Agent can search Slack messages across a specific workspace via `searchSlack` tool.
- **History**: Agent can read channel/DM history via `readSlackHistory` tool.
- **Send**: Agent can send messages via `sendSlackMessage` tool.
- **Contact Sync**: Import Slack users from all connected workspaces into the People database via the "Sync Slack" button on the People page.

### Monitored Channels
You can configure which Slack channels should be scanned *per workspace* by scheduled tasks (morning briefings, proactive thought):

1. Go to **Settings → Slack** in the Web UI.
2. Under any connected workspace, click **Configure**.
3. Search and select the channels you want monitored (checkboxes).
4. Click **Save**. The setting is securely stored per-workspace in the Interfaces service.
5. Scheduled tasks use the `getSlackMonitoredChannels` combined with `readSlackHistory` tools to fetch and read across all connected workspaces dynamically.

**Tip**: To include Slack in your morning briefing, add this to your task prompt:
> "Also check Slack: use getSlackMonitoredChannels to get the list of channels, then readSlackHistory on each."

---

## 🎙️ Gemini Live (Real-Time)
Deedee supports the **Gemini Live API** for real-time, low-latency voice interaction at `/live`.

### Architecture
-   **Client**: The Web UI (`apps/web/src/app/live/page.js`) opens a WebSocket straight to Google:
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=<token>`.
    The pure helpers in `apps/web/src/app/live/live-session.js` pick the URL and build the setup message.
-   **Token**: `POST /v1/live/token` on the API proxies to `POST /live/token` on the Agent. The Agent mints an
    ephemeral token with `client.authTokens.create` and its `GOOGLE_API_KEY`: one use, a session of up to
    30 minutes, and the browser must connect within 2 minutes. `liveConnectConstraints` plus
    `lockAdditionalFields: []` lock the token to the `LIVE` model (`WORKER_LIVE`) and to
    `responseModalities: ['AUDIO']`; the setup message supplies the rest. The response is `{ token, model, expiresAt }`.
-   **Config**: `GET /v1/live/config` returns `{ model, voice, systemInstruction }`. The Agent builds the system
    instruction in `apps/agent/src/prompts/live.js` from the chat prompt's identity, constitution and language
    rules, the owner's communication style, and a facts block capped at about 1,500 tokens (the whole
    instruction at about 3,000). The coding prompt and the tool protocols stay out. The Agent logs the size on
    each call; the page logs the size of the whole setup message.
-   **Setup**: camelCase, as the `@google/genai` SDK sends it: `setup.model`, `setup.generationConfig.responseModalities`,
    `setup.generationConfig.speechConfig`, `setup.systemInstruction.parts` and `setup.tools` (`googleSearch` plus
    the Agent's function declarations, cleaned by `cleanSchema`). Microphone audio goes out as `realtimeInput.audio`.
-   **Tools**: The client forwards each `toolCall` to `POST /v1/live/tools/execute`, which proxies to
    `POST /tools/execute` on the Agent, then answers Google with `toolResponse.functionResponses`.

### Requirements
-   `GOOGLE_API_KEY` on the `agent` service. Google rejects service-account OAuth tokens on the Live socket
    (close code 1008, "Access to Gemini API is restricted with service accounts"), so the old
    `google-auth-library` path is gone.
-   Keep `lockAdditionalFields: []` when you change the constraints. A token with constraints and no field
    mask makes Google ignore the browser's setup message, tools included.

### Features
-   **Language Detection**: The Agent's Live prompt tells the model to speak the language the user speaks.
-   **Interruptibility**: You can interrupt the model at any time.
-   **Tool Use**: Full access to Deedee's toolset (WhatsApp, Calendar, etc.) via the proxy mechanism.

---

## 🔍 WhatsApp Contact Integration
The agent can now resolve contact names to phone numbers using your WhatsApp contact list.

### Usage
-   **Sync**: You can manually import contacts from the Web UI (People Page) using the "Sync WhatsApp" button. Contacts are also passively verified when they message the bot.
-   **Search**: You can search contacts in the Web UI settings to verify visibility.
-   **Tool**: The agent uses the `searchContacts` tool to find numbers when you say "Send message to Alice".
-   **Safeguard**: The agent will NOT send messages to unknown numbers by default unless explicitly instructed (or if they are in the `allowedNumbers` list).

### Identity Resolution
-   **Centralized Resolver**: All WhatsApp identity resolution goes through `resolveIdentity()` in the SQLiteStore. This handles phone JIDs, LIDs (Linked IDs), raw digits, and fuzzy suffix matching in a single entry point.
-   **API Endpoint**: `GET /v1/whatsapp/resolve?identifier=<phone|lid|digits>` returns the canonical phone JID, LID, name, and all known JIDs for a contact.
-   **Cross-JID History**: Chat history queries automatically merge messages from both phone JID and LID for the same contact.
