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
-   **Sync**: Contacts are automatically verified when they message the bot or when the bot syncs the session.
-   **Search**: You can search contacts in the Web UI settings to verify visibility.
-   **Tool**: The agent uses the `searchContacts` tool to find numbers when you say "Send message to Alice".
-   **Safeguard**: The agent will NOT send messages to unknown numbers by default unless explicitly instructed (or if they are in the `allowedNumbers` list).
