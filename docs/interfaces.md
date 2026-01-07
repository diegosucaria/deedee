# Intefaces & Channels

Deedee communicates with you through various "Interfaces". The main `apps/interfaces` service handles these connections.

## 📱 WhatsApp

Deedee uses [Baileys](https://github.com/WhiskeySockets/Baileys) to connect to WhatsApp Multi-Device.

### Setup
1.  **Enable**: The service is enabled by default.
2.  **Environment Variables**:
    -   `ALLOWED_WHATSAPP_NUMBERS`: Comma-separated list of phone numbers (with country code, no `+`) allowed to talk to the bot.
        -   Example: `ALLOWED_WHATSAPP_NUMBERS=15550123456,15550987654`
        -   **Security**: If left empty, the bot **IGNORES ALL MESSAGES** (Secure by Default). You *must* set this to enable access.

    > [!TIP]
    > **Recommended Setup**: Run Deedee on a **secondary phone number** (spare SIM/WA Business).
    > 1.  Scan the QR code with your **Secondary Phone** (Deedee becomes this number).
    > 2.  Set `ALLOWED_WHATSAPP_NUMBERS` to your **Primary Phone Number**.
    > 3.  You (Primary) -> Message -> Deedee (Secondary). Deedee executes tasks and replies.
3.  **Linking**:
    -   Go to your Deedee Dashboard: `https://<your-url>/interfaces` (or `/whatsapp`).
    -   Click the **WhatsApp** tab.
    -   You will see a QR Code.
    -   Open WhatsApp on your phone -> **Linked Devices** -> **Link a Device**.
    -   Scan the QR Code.
4.  **Status**:
    -   The dashboard will show "Connected".
    -   Session data is stored persistently in `/app/data/baileys_auth`.

### Features
-   **Text**: Send/Receive text messages.
-   **Audio**: Receive voice notes (Agent transcribes them). Send voice replies (Agent uses TTS).
-   **Images**: Receive images (Agent analyzes them).
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
