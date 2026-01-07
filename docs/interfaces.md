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
