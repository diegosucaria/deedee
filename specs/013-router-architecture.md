# Spec 013: Router Architecture & Chat Hydration

## 1. Context & Goal
The current agent uses a single, static model instance (`gemini-1.5-pro`) for all interactions. This creates two problems:
1.  **Latency**: Simple commands (e.g., "Turn on lights") are slow (~2s) because they use the large reasoning model.
2.  **Inflexibility**: We cannot switch models mid-conversation because the chat state is locked in memory.

**Goal**: Implement a **Router-Worker** architecture where a fast, cheap model routes requests to the appropriate "Worker" model (Fast vs. Reasoning). This architecture requires **Dynamic Chat Hydration** to reconstruct the conversation context for the selected worker.

## 2. Architecture

### 2.1 The Router (Layer 1)
- **Model**: `gemini-2.0-flash` (or current fastest available).
- **Role**: Intent Classification.
- **Latency Target**: < 500ms.
- **Input**: System Prompt + **Last 1-2 User Messages** (No full history).
- **Output**: JSON `{"model": "FLASH" | "PRO", "reason": "..."}`.
- **Temperature**: 0.0 (Strict).

**Routing Logic**:
- **FLASH**: Home automation, simple queries, casual chat, facts.
- **PRO**: Coding, architecture, complex planning, creative writing, analysis.

### 2.2 The Workers (Layer 2)
- **Worker A (Fast)**: `gemini-2.0-flash`. Handles tools and simple chats.
- **Worker B (Reasoning)**: `gemini-1.5-pro` (or `gemini-exp-1206` / `gemini-3-pro-preview`). Handles complex tasks.
- **Context**: Receives the **Full Conversation History** (hydrated from DB).

## 3. Implementation Plan

### 3.1 Database: Chat Hydration
We need to fetch history formatted for the Gemini SDK to "hydrate" the workers.

- **Update `AgentDB`**:
    - Add `getHistoryForChat(chatId, limit)` method.
    - Map stored rows to SDK format: `{ role: 'user' | 'model', parts: [{ text: content }] }`.

### 3.2 Agent Refactoring (`Agent.js`)
Refactor `onMessage` to be stateless per turn.

**Flow:**
1.  **Receive Message**: User inputs text.
2.  **Route**: 
    - Call Router Model (stateless).
    - Parse JSON decision.
    - Default to `PRO` on JSON parse error.
3.  **Hydrate**:
    - Fetch last N (e.g., 20) messages from `AgentDB` for this `chatId`.
4.  **Initialize Worker**:
    - Create a *new* `ChatSession` using the selected model (Flash/Pro) and the hydrated `history`.
    - *Note*: We do not maintain a persistent `this.chat` object anymore.
5.  **Execute**:
    - Send message to the Worker.
    - Handle Tool calls (same loop as before).
6.  **Persist**:
    - Save User message and Model response to `AgentDB`.

### 3.3 Configuration
- `ROUTER_MODEL`: default `gemini-2.0-flash-exp`
- `FAST_MODEL`: default `gemini-2.0-flash-exp`
- `REASONING_MODEL`: default `gemini-1.5-pro`

## 4. Risks & Mitigations
- **Context Loss**: If hydration fails, the model loses memory.
    - *Test*: Write a test that restarts the agent and checks if it remembers the user's name.
- **Router Latency**: Adds a network hop.
    - *Mitigation*: Use the fastest possible model for routing. The parallel execution of Router + Fast Worker is still faster than 1.5 Pro.
- **Cost**: Router adds a call, but diverting 80% of traffic to Flash saves money overall.

## 5. Definition of Done
- [ ] `AgentDB` supports fetching history in SDK format.
- [ ] `Agent` has a `Router` method/class.
- [ ] `Agent.onMessage` uses the Router to select a model.
- [ ] `Agent` re-initializes chat context from DB for every message (Hydration).
- [ ] Unit tests verify routing logic (mocked).
- [ ] Integration test verifies "memory" persists across restarts.
