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
        - Audio/Voice -> Download stream -> Buffer -> Base64 -> `parts` (`inlineData`: `audio/ogg`).
        - Images -> Download stream -> Buffer -> Base64 -> `parts` (`inlineData`: `image/jpeg`).
    - **Security**: Check `remoteJid` against `ALLOWED_WHATSAPP_NUMBERS` env var.
    - **Slash Commands**: Messages starting with `/` (e.g., `/imagine`, `/stop`) are passed natively to the Agent, which handles them via `CommandHandler`.

- **Outgoing**:
    - Implement `sendMessage(to, content, options)`.
    - **Text**: Standard text messages.
    - **Audio**: Sends `audio/ogg; codecs=opus` PTT (Voice Note).
    - **Image**: Sends JPEG/PNG images.

## Features & Capabilities
1.  **Multi-Modal**: Full support for receiving and sending Voice Notes and Images.
2.  **Slash Commands**: Supports standard agent commands (e.g. `/imagine`, `/stop`, `/clear`).
3.  **Security**:
    -   `ALLOWED_WHATSAPP_NUMBERS`: Strict allowlist for incoming messages.
    -   **Secure by Default**: If `ALLOWED_WHATSAPP_NUMBERS` is not set or empty, **ALL** messages are ignored (logged as error).
    -   Unauthorized numbers are blocked with a warning log.
4.  **Persistence**: Authentication state (QR/Keys) is persisted in `/app/data/baileys_auth`.

## Deployment Models
You can configure Deedee in two main ways using the same codebase:

### Option A: Self-Hosted Personal Assistant (Single Number)
-   **Device**: Your primary phone scans the QR code.
-   **Allowed Number**: Your own number.
-   **Behavior**: You send messages to "yourself" (Note to Self). Deedee replies to you.
-   **Pros**: Easiest setup.
-   **Cons**: Chatting with yourself can be confusing in WhatsApp UI.

### Option B: Dedicated Bot Number (Dual Number - Recommended)
-   **Device**: A secondary phone (or WhatsApp Business app) scans the QR code.
-   **Allowed Number**: Your primary phone number.
-   **Behavior**: You (Primary) chat with Deedee (Secondary). Use it like a contact.
-   **Pros**: Clean separation, feels like a real assistant.
-   **Setup**:
    1.  Scan QR with Secondary Phone.
    2.  Set `ALLOWED_WHATSAPP_NUMBERS=<Your_Primary_Number>`.

## Data Model Changes
- **Env Vars**:
    - `ALLOWED_WHATSAPP_NUMBERS`: Comma-separated list of allowed phone numbers (e.g., `54911..., 1415...`).
    - `ENABLE_WHATSAPP`: Toggle to enable/disable the service (default: true).

## Implementation Steps
- [x] **Dependencies**: `npm install @whiskeysockets/baileys qrcode-terminal` in `apps/interfaces`.
- [x] **Service Class**: Create `WhatsAppService` in `src/whatsapp.js`.
- [x] **Server Hook**: Initialize `WhatsAppService` in `src/server.js` if enabled.
- [x] **Media Handling**: Implement `downloadMediaMessage` for Audio/Images.
- [x] **Testing**: Verify QR generation, scanning, and message flow.

## Risks / mitigations
- **Disconnects**: Baileys connection can be flaky. Implement robust reconnection logic with exponential backoff.
- **Session Loss**: Ensure `/app/data` is mounted correctly in `docker-compose.yml`.
