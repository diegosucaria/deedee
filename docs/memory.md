# Agent Persistence & Memory System

## Overview
Deedee uses a local SQLite database to maintain state across restarts. This ensures that the agent retains context, remembers user preferences, and can resume tasks after a self-improvement update.

## Database Location
- **Path**: `/app/data/agent.db`
- **Volume**: `agent-data` (Docker volume, preserved across container rebuilds).

## Memory Types

### 1. Episodic Memory (Conversation History)
- **Table**: `messages`
- **Content**: Every incoming user message and outgoing assistant reply is saved.
- **Usage**: Used to rebuild the context window (not fully implemented yet, currently just logging).
- **Agent Access**: Automatic (background).

### 2. Semantic Memory (Facts & Preferences)
- **Table**: `kv_store`
- **Content**: Key-Value pairs for long-term storage.
- **Agent Access**:
    - `rememberFact(key, value)`: Save information (e.g., `user_name`, `api_key_x`).
    - `getFact(key)`: Retrieve information.

### 3. Intentional Memory (Goals)
- **Table**: `goals`
- **Content**: High-level tasks or intentions.
- **Usage**: solving the "Amnesia Problem".
    1.  Before starting a complex task (like an update), the Agent should add a goal.
    2.  On system boot, the Agent checks for `pending` goals.
    3.  If found, it knows *why* it is running and can resume work.

## Self-Improvement Workflow
1.  **Plan**: Agent decides to add a feature.
2.  **Persist**: Agent calls `db.addGoal("Update agent.js to add feature X")`.
3.  **Execute**: Agent instructs Supervisor to update code.
4.  **Restart**: Supervisor pushes code -> Balena updates -> Container restarts.
5.  **Resume**:
    - Agent boots up.
    - Reads `goals` table.
    - Sees "Update agent.js...".
    - Says: "I am back. Verifying feature X..."

## Schema Reference
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  role TEXT,
  content TEXT,
  source TEXT,
  chat_id TEXT,
  timestamp DATETIME
);

CREATE TABLE kv_store (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY,
  description TEXT,
  status TEXT
);
```
