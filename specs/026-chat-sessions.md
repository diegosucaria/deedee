# Spec: Chat Sessions & History Management

## Goal
Enable persistent, multi-threaded chat sessions similar to ChatGPT/Gemini Web UI. Users should be able to create new chats, view history, and resume past conversations via the Web Interface.

## Database Schema (AgentDB)

### New Table: `chat_sessions`
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | TEXT (UUID) | Primary Key |
| `title` | TEXT | Auto-generated summary of the chat (default: "New Chat") |
| `created_at` | DATETIME | Session creation time |
| `updated_at` | DATETIME | Last activity time |
| `is_archived` | INTEGER (Boolean) | Soft delete / archive status |

### Updates to `messages` Table
*   Ensure `chat_id` foreign key relationship (logical) to `chat_sessions.id`.

### Integration with Smart Context (Existing)
*   **History Hydration**: Use the existing `AgentDB.getHistoryForChat(chatId, limit)` method. This method already maps DB rows to Gemini `Content` objects.
*   **Summarization**: Leverage the existing `summaries` table and `AgentDB.getLatestSummary(chatId)`.
    *   When loading a session, the Agent must check for a summary and inject it into the system instruction or context window.
    *   The existing `Auto-summarization` logic in `Agent.processMessage` should continue to work per-session, ensuring `chatId` is propagated correctly.
*   **Token Usage**: Existing `token_usage` table already has `chat_id`. Ensure UI pulls this data for "Cost per Session" display.

## API Endpoints (Interfaces Service)

### `GET /sessions`
*   **Returns**: List of active sessions, sorted by `updated_at` DESC.
*   **Response**: `[{ id, title, updated_at, preview: "last message..." }]`

### `POST /sessions`
*   **Action**: Creates a new empty session.
*   **Response**: `{ id, title, created_at }`

### `GET /sessions/:id`
*   **Action**: Retrieves full message history for a session.
*   **Response**: `{ id, title, messages: [{ role, content, timestamp, ... }] }`

### `PUT /sessions/:id`
*   **Action**: Update session metadata (e.g., Title, Archived status).
*   **Body**: `{ title?: string, is_archived?: boolean }`

### `DELETE /sessions/:id`
*   **Action**: Hard delete session and associated messages.

## Agent Logic (`apps/agent`)
*   **Auto-Titling**: When the first user message arrives in a new session (detected if `messages.count === 1`), trigger a lightweight LLM call (Gemini Flash) to generate a short 3-5 word title and update `chat_sessions` table.
*   **Context Management**: 
    *   Ensure `Agent.processMessage` strictly respects the `chatId` passed in metadata.
    *   **Crucial**: The `Agent` constructor or `processMessage` needs to ensure the *internal* state (if any) is scoped to the `chatId`. Since the Agent is currently stateless between requests (relying on DB), passing `chatId` to `processMessage` should be sufficient, provided all DB lookups use it.

## Web UI (`apps/web`)
*   **Sidebar**: List of "Recent Chats".
*   **New Chat Button**: Clears current view, generates new Session ID.
*   **Chat Interface**:
    *   URL Routing: `/chat/:id`
    *   Optimistic updates for immediate feedback.
    *   Markdown rendering for bot responses.

## Implementation Details
*   **Backfilling**: A `migrateSessions()` function runs on Agent startup. It scans for messages with a `Metadata` JSON string containing `chatId` but no corresponding `chat_sessions` entry, creating one automatically.
*   **Enforcement**: `ensureSession(chatId)` is called before processing any message to guarantee referential integrity.
*   **Router**: `apps/agent/src/router.js` now receives filtered history specific to the active `chatId`.

