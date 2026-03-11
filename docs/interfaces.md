# Intefaces & Channels

Deedee communicates with you through various "Interfaces". The main `apps/interfaces` service handles these connections.

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
Deedee supports the high-performance **Gemini Live API** for real-time, low-latency voice interaction.

### Architecture
-   **Client**: The Web UI (`apps/web`) establishes a WebSocket connection directly to Google's servers.
-   **Proxy**: Initial authentication is handled via `POST /v1/live/token` on the API, which proxies to the Agent to generate an ephemeral token.
-   **Tools**: The Client acts as a "Tool Client", executing tools locally (like `get_weather`) or forwarding complex tool calls (like `send_whatsapp`) back to the Agent via `POST /v1/live/tools/execute` (which proxies to `POST /tools/execute` on the Agent).

### Features
-   **Language Detection**: Automatically detects language based on the user's voice (configured via system instruction).
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
