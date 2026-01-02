# Spec 013: Router Architecture & Chat Hydration

## 1. Context & Goal
The Agent needs to be stateless and scalable. We will separate intent classification (Router) from execution (Worker).

## 2. Architecture

### 2.1 The Router (Layer 1)
- **Model**: `gemini-3-flash-preview` (or latest `gemini-2.0-flash-exp`).
- **Input**: System Prompt + Last 1 User Message (Latency optimized).
- **Prompt**: "Is this a simple command/chat or a complex reasoning task?"
- **Output**: JSON `{"model": "FLASH" | "PRO", "reason": "..."}`.
- **Routing Logic**:
    - **FLASH**: Home automation, simple queries, casual chat, facts.
    - **PRO**: Coding, architecture, complex planning, creative writing, analysis.

### 2.2 The Workers (Layer 2)
- **FLASH Worker**: `gemini-3-flash-preview`. Handles tools and simple chats on the spot.
- **PRO Worker**: `gemini-3-pro-preview` (or `gemini-exp-1206`). Handles reasoning.
- **Context**: Must be **Hydrated** from `AgentDB`.

## 3. Implementation Plan

### 3.1 Database: Chat Hydration
- **New Method**: `db.getHistoryForChat(chatId, limit)`
    - Fetches rows.
    - Maps to SDK format:
      ```javascript
      [
        { role: 'user', parts: [{ text: '...' }] },
        { role: 'model', parts: [{ text: '...' }] }
      ]
      ```
    - Handles proper `role` mapping (Agent 'assistant' -> Gemini 'model').

### 3.2 Router Class
- `Router.route(userMessage)` -> returns `{ modelName, historyLimit }`.

### 3.3 Agent Refactoring
- Remove persistent `this.chat`.
- **New Flow**:
    1. `onMessage(msg)`
    2. `Router.route(msg.content)`
    3. `db.getHistoryForChat(msg.chatId, 50)`
    4. `client.chats.create({ model: selectedModel, history: hydratedHistory })`
    5. `chat.sendMessage(msg.content)`
    6. Save result.

## 4. Models Configuration
- `ROUTER_MODEL`: `gemini-2.0-flash-exp` (fallback if 3-flash-preview unavailable).
- `WORKER_FLASH`: `gemini-2.0-flash-exp`.
- `WORKER_PRO`: `gemini-exp-1206`.
