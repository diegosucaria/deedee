# Spec 003: Telegram Interface

## Objective
Implement the Telegram connector in `apps/interfaces` using Long Polling.

## Components

### 1. Telegram Service (`apps/interfaces/src/telegram.js`)
- **Library**: `telegraf`
- **Mode**: Polling
- **Role**:
    1. Listen for text messages.
    2. Convert them to `Message` object (shared type).
    3. POST to `AGENT_URL/webhook`.

### 2. HTTP Server (`apps/interfaces/src/server.js`)
- **Role**: Listen for outgoing messages from Agent.
- **Endpoint**: `POST /send`
    - Body: `{ chatId: string, content: string }`
    - Action: `bot.telegram.sendMessage(chatId, content)`

## Scenario: User Says Hello

**Given** the Telegram Bot is polling.
**When** User sends "Hello" to the bot.
**Then** the Service should POST `{ content: "Hello", source: "telegram", ... }` to the Agent.

## Scenario: Agent Replies

**Given** the Agent wants to reply.
**When** Agent POSTs to `http://interfaces:5000/send` with `{ chatId: "123", content: "Hi" }`.
**Then** the Telegram Bot should send "Hi" to chat "123".

## Implementation Plan
1. Update `apps/interfaces/src/telegram.js` (Bot logic).
2. Update `apps/interfaces/src/server.js` (Express + Bot).
3. Create test `apps/interfaces/tests/telegram.test.js`.
