# Spec 012: Dynamic Chat Hydration & Long-Term Memory

## 1. Context & Problem
Currently, the Agent uses a single global `this.chat` instance. This has two critical flaws:
1.  **Amnesia on Restart**: If the Agent container restarts, the in-memory context is lost, even though messages are persisted in SQLite.
2.  **Context Bleed**: All messages from all sources (if we add multiple interfaces or chat IDs) feed into a single context window.

## 2. Goals
- **Per-Chat Isolation**: Maintain separate context windows for different `chatId`s.
- **Persistence**: Restore the state of a conversation from the database after a restart.
- **Scalability**: Prevent context window overflow using summarization.

## 3. Implementation Plan

### 3.1. Database Updates (`AgentDB`)
- **New Method**: `getHistoryForChat(chatId, limit = 20)`
    - Returns messages formatted strictly for the Gemini SDK `history` parameter.
    - Format: `{ role: 'user' | 'model', parts: [{ text: "..." }] }`

### 3.2. Agent Refactoring (`Agent` class)
- **Remove**: Global `this.chat`.
- **New State**: `this.sessions = new Map<string, ChatSession>();`
- **Logic**: `getOrCreateSession(chatId)`
    1.  Check `this.sessions` for `chatId`.
    2.  If missing, fetch last N messages from `AgentDB`.
    3.  Initialize `client.chats.create({ history: loadedHistory })`.
    4.  Store in Map.

### 3.3. Long-Term Memory (Summarization)
- **Trigger**: Every N turns (e.g., 20).
- **Action**:
    1.  Ask a lightweight model (or the same model) to "Summarize the key facts and preferences from this conversation so far."
    2.  Store summary in a new `summaries` table or `kv_store` linked to `chatId`.
    3.  **Context Injection**: When creating a new session, prepend the "System Instructions" with:
        > "Previous conversation summary: {summary_text}"

## 4. Risks & Mitigations
- **Token Costs**: Re-reading large history or running summarization increases cost.
    - *Mitigation*: Configurable history limit (e.g., last 10 messages).
- **Latency**: Initializing a chat with history might add slight overhead.
    - *Mitigation*: Keep the session cached in memory as long as possible.

## 5. Verification Plan
- **Test Case 1 (Hydration)**:
    1.  User says "My name is Diego".
    2.  Restart Agent.
    3.  User says "What is my name?".
    4.  Agent must reply "Diego" (proving it read the DB).
- **Test Case 2 (Isolation)**:
    1.  Chat A says "Secret is 123".
    2.  Chat B asks "What is the secret?".
    3.  Agent in Chat B should not know.
