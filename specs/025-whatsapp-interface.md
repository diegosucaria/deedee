# WhatsApp Interface Specification

## Goal
Enable receiving and sending WhatsApp messages via the `apps/interfaces` service, allowing the Agent to interact with users on WhatsApp.

## Library Strategy
Use **@whiskeysockets/baileys** (v6+).
- **Reason**: Lightweight, runs on Node.js without a full browser (unlike Puppeteer), supports multi-device auth.

## Architecture

### 1. New Service Integration
- **File**: `apps/interfaces/src/whatsapp.js`
- **Class**: `WhatsAppService`
- **Responsibilities**:
    - Handle Auth/Session lifecycle.
    - Connect to WhatsApp Websocket.
    - Listen for `messages.upsert` events.
    - Forward valid messages to Agent (`POST /chat`).
    - Handle sending messages (Text, Audio, Image).

### 2. Authentication & Persistence
- **Credentials**: Baileys uses a folder to store session keys.
- **Path**: `/app/data/baileys_auth` (Must be persistent volume in Docker/Balena).
- **First Run**:
    - Generate QR Code.
    - Print QR to Console (ASCII).
    - **Bonus**: Expose QR via a simple HTTP endpoint (`GET /whatsapp/qr`) or push to the Dashboard so the user can scan it easily.

### 3. Message Handling
- **Incoming**:
    - Listen to `messages.upsert`.
    - Filter for `notify` (new messages).
    - Ignore status updates / broadcasts if irrelevant.
    - Map WhatsApp Message -> Deedee Message Format.
        - Text -> `content`
        - Audio/Voice -> Download stream -> Base64 -> `parts` (similar to Telegram logic).
        - Images -> Download stream -> Base64 -> `parts`.
    - **Security**: Check `remoteJid` against `ALLOWED_WHATSAPP_NUMBERS` env var.

- **Outgoing**:
    - Implement `sendMessage(to, content, options)`.
    - Support Text, Image, Audio.

## Data Model Changes
- **Env Vars**:
    - `ALLOWED_WHATSAPP_NUMBERS`: Comma-separated list of allowed phone numbers (e.g., `54911..., 1415...`).

## Implementation Steps

1.  **Dependencies**: `npm install @whiskeysockets/baileys qrcode-terminal` in `apps/interfaces`.
2.  **Service Class**: Create `WhatsAppService` in `src/whatsapp.js`.
3.  **Server Hook**: Initialize `WhatsAppService` in `src/server.js` if enabled.
4.  **Testing**: Verify QR generation, scanning, and message flow.

## Risks / mitigations
- **Disconnects**: Baileys connection can be flaky. Implement robust reconnection logic with exponential backoff.
- **Session Loss**: Ensure `/app/data` is mounted correctly in `docker-compose.yml`.
