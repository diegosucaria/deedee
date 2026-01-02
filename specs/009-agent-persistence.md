# Spec 009: Agent Persistence

## Objective
Implement persistent memory for the Agent using SQLite, allowing it to remember conversation history and active goals across restarts.

## Components

### 1. Database Manager (`apps/agent/src/db.js`)
- **Library**: `better-sqlite3`
- **Location**: `/app/data/agent.db` (Persistent Volume)
- **Schema**:
    - `messages`: id, role, content, source, timestamp, chat_id.
    - `kv_store`: key, value (JSON).
    - `goals`: id, description, status (pending/completed), created_at.

### 2. Agent Integration
- **Boot**: Load pending goals from `kv_store`/`goals`.
- **On Message**: Save user message and assistant reply to `messages`.
- **Tool Use**: Expose `memory_save(key, value)` and `memory_load(key)` to the Agent.

## Scenario: "Remember my name"

**Given** User says "My name is Diego".
**When** Agent decides to save this fact.
**Then** Agent calls `memory_save('user_name', 'Diego')`.
**And** Future restarts can retrieve this via `memory_load('user_name')`.

## Scenario: "Resuming a Task" (Anti-Amnesia)

**Given** Agent is about to trigger an update.
**When** Agent writes to `goals`: "Waiting for update to fix bug X".
**And** System restarts.
**Then** On boot, Agent reads `goals` and sees "Waiting for update...".
**And** Agent sends a message "I am back online. Checking if the update worked."

## Implementation Plan
1. Create `apps/agent/src/db.js`.
2. Update `apps/agent/src/agent.js` to use DB.
3. Expose Memory Tools to Gemini.
