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
    
### 4. Journal (Second Brain)
- **Files**: `/app/data/journal/YYYY/MM/DD.md`
- **Content**: Daily logs, summaries, and notes.
- **Agent Access**:
    - `logJournal(text)`: Append to today's entry.
    - `readJournal(date)`: Read a specific day.
    - `searchJournal(query)`: Semantic/Text search across all entries.
- **Automation**: `nightly_consolidation` job summarizes chat logs into the journal at midnight.

### 5. Social Memory (People)
- **Table**: `people`
- **Content**: Contact information, relationships, and interaction notes.
- **Agent Access**:
    - `listPeople()`, `getPerson(id)`, `searchPeople(query)`: Retrieval.
    - `updatePerson(id, updates)`: Modification.
- **Automation**: "Smart Learn" analyzes WhatsApp history to suggest new contacts.

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
  status TEXT,
  metadata TEXT -- JSON string (e.g. { "chatId": "123" })
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  relationship TEXT,
  source TEXT,
  notes TEXT,
  identifiers TEXT, -- JSON (e.g. { "whatsapp": "123@s.whatsapp.net" })
  metadata TEXT, -- JSON
  created_at DATETIME,
  updated_at DATETIME
);

CREATE TABLE verified_contacts (
  service TEXT,
  contact_id TEXT,
  verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (service, contact_id)
);
```
