# Memory Architecture

## Overview
DeeDee uses a multi-tiered memory architecture to maintain state, context, and long-term knowledge across restarts. The core relies on SQLite, augmented by Markdown files for journaling and RAG (Retrieval-Augmented Generation) for semantic search.

## Architecture

```
                    ┌──────────────┐
                    │  Chat Logs   │  (Agent DB + WhatsApp DB)
                    └──────┬───────┘
                           │ /consolidate (or nightly at 2AM)
                           ▼
                    ┌──────────────┐
                    │   Gemini Pro │  LLM extracts summary + facts
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
     ┌──────────────┐ ┌─────────┐ ┌──────────┐
     │   Journal    │ │ KV Facts│ │ MEMORY.md│
     │  (daily .md) │ │ (SQLite)│ │  (auto)  │
     └──────┬───────┘ └────┬────┘ └────┬─────┘
            │              │           │
            ▼              │           ▼
     ┌──────────────┐      │    ┌──────────────┐
     │  RAG Embed   │      │    │  RAG Embed   │
     │ vault:journal│      │    │ vault:memory │
     └──────┬───────┘      │    └──────┬───────┘
            │              │           │
            └──────────────┼───────────┘
                           ▼
                    ┌──────────────┐
                    │ searchMemory │  Chat history + RAG hybrid
                    └──────────────┘
```

## Database Locations
- **Agent DB**: `/app/data/agent.db` (messages, kv_store, goals, people, summaries)
- **WhatsApp DB**: `/app/interfaces-data/messages_user.db` (Baileys/SQLite, read-only mount)
- **RAG DB**: `/app/data/rag.db` (document chunks + vector embeddings)
- **Volume**: `agent-data` (Docker volume, preserved across rebuilds)

## Memory Types

### 1. Episodic Memory (Chat History)
- **Tables**: `chat_sessions`, `messages`
- **Content**: All user messages and assistant replies grouped by session
- **Context Management**: `summaries` table tracks sliding-window summaries (`smart-context.js`) injected into prompts without passing full raw history

### 2. Semantic Memory (KV Facts)
- **Table**: `kv_store`
- **Content**: Key-value pairs with metadata for long-term storage (preferences, relationships, settings)
- **Schema**: `key TEXT PRIMARY KEY, value TEXT, category TEXT, confidence TEXT, source TEXT, created_at DATETIME, pinned INTEGER, updated_at DATETIME`
- **Categories**: `preference`, `relationship`, `temporal`, `system`, `general`
- **Confidence levels**: `user_explicit` (stated by user), `consolidated` (extracted by LLM), `inferred` (system-derived)
- **Sources**: `manual` (dashboard), `tool` (rememberFact), `consolidation` (nightly), `system`
- **Pinning**: Facts can be pinned (via dashboard or API) to protect from auto-pruning and consolidation overwrite
- **Agent Access**: `rememberFact(key, value)`, `getFact(key)`
- **RAG Sync**: Facts are synced to `data/MEMORY.md` and embedded into RAG (vault: `memory`)
- **Pruning**: Nightly job uses Gemini to cull stale/obsolete facts, backed up to `data/pruned_memories.json`. Pinned facts are excluded from the pruning prompt and have a server-side safety net.
- **Contradiction Detection**: During consolidation, if a new fact value conflicts with an existing one, the change is logged to the journal. Pinned facts block the overwrite entirely.
- **Data Segregation**: Internal keys (`config:*`, `job:*`, `sys_*`, `sch_*`) are filtered from user-facing API responses

### 3. Journal (Daily Summaries)
- **Files**: `data/journal/YYYY-MM-DD.md` (append-only)
- **Content**: Consolidation summaries, manual notes, events, fact change audit trail
- **Agent Access**: `logJournal(text)` (write), `readJournal(date)`, `searchJournal(query)` (internal)
- **Search**: Uses RAG (semantic + FTS5) when available, falls back to naive file scan
- **RAG Sync**: Embedded into RAG (vault: `journal`), files under 200 chars are skipped (system noise)
- **Automation**: `nightly_consolidation` at 2AM, manual via `/consolidate`

### 4. Intentional Memory (Goals)
- **Table**: `goals` (columns: `description`, `status`, `metadata`, `progress`, `last_activity_at`, `created_at`)
- **Content**: Multi-session work the AGENT is executing that must survive a restart. NOT for user TODOs — those go through `scheduleJob` (reminders) or stay as chat responses.
- **Checkpoints**: Agent calls `updateGoalProgress` after each significant step, writing a free-form state string (cursors, IDs, counts) that future-agent reads to resume.
- **Solves**: The "Amnesia Problem" — on boot, agent reads each pending goal's last checkpoint and resumes from there. Rule of thumb: if restarting wouldn't lose progress, it's not a goal.

### 5. Social Memory (People)
- **Table**: `people`
- **Content**: Contacts with relationship mapping, phone numbers, WhatsApp JIDs
- **Agent Access**: `listPeople()`, `getPerson(id)`, `searchPeople(query)`, `updatePerson(id, updates)`
- **Special**: Autopilot status, identifier mappings, Smart Learn (auto-discovers contacts)

## Search Precedence

| Priority | Source | When Used |
|----------|--------|-----------|
| **1 (Highest)** | KV Facts via `getFactsFormatted()` | Injected into **every** system prompt automatically |
| **2** | `searchMemory` (chat history + RAG) | Agent calls this tool for memory queries |
| **3** | `searchDocuments` (vault files only) | Agent calls this for uploaded document search |

KV Facts are the ground truth — always in context. Journal and RAG content only surfaces through explicit tool calls.

### searchMemory Flow
When the agent calls `searchMemory(query)`:
1. **Chat history**: `db.searchMessages(query)` — SQLite text search through raw messages
2. **RAG**: `ragService.search(query)` — hybrid vector + FTS5 across all vaults (journal, memory, user vaults)
3. Returns both as `{ chat_history, knowledge }` so the agent can reason across sources

### RAG Search Pipeline
The RAG service uses a dual search strategy:
1. **sqlite-vec path** (preferred): KNN via `vec0` virtual table → over-fetch 4x → re-rank with FTS5 boost. Requires the `sqlite-vec` native extension.
2. **Brute-force fallback**: O(n) cosine similarity across all chunk embeddings. Used when sqlite-vec is unavailable.
3. **FTS5 flexibility**: Exact phrase match first, then `token1* OR token2* OR token3*` prefix fallback.
4. **Relevance threshold**: Results below `minScore` (default 0.3) are filtered out.

## Nightly Schedule

| Time | Job | Description |
|------|-----|-------------|
| 2:00 AM | `nightly_consolidation` | Summarize yesterday's chats → journal + facts |
| 3:00 AM | `nightly_rag_scan` | Re-embed vaults, journals, and MEMORY.md |
| 4:00 AM | `nightly_memory_pruning` | Delete stale temporal facts (>7 days old) |
| 4:30 AM | `nightly_dream` | Creative synthesis from recent memories |

## Self-Improvement Workflow
1. **Plan**: Agent decides to do multi-session work it might not finish in one session
2. **Persist**: Creates a goal via `addGoal` tool
3. **Checkpoint**: Calls `updateGoalProgress` after each step with enough state to resume cold
4. **Restart**: Supervisor/deploy/crash → container restarts
5. **Resume**: Agent reads each pending goal's `progress` string and continues from the checkpoint

## Schema Reference
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY, role TEXT, content TEXT,
  source TEXT, chat_id TEXT, timestamp DATETIME, metadata TEXT
);
CREATE TABLE kv_store (
  key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME,
  category TEXT DEFAULT 'general', confidence TEXT DEFAULT 'inferred',
  source TEXT DEFAULT 'system', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  pinned INTEGER DEFAULT 0
);
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
  content TEXT NOT NULL, range_end TEXT, summary_tokens INTEGER
);
CREATE TABLE goals (
  id INTEGER PRIMARY KEY, description TEXT, status TEXT, metadata TEXT,
  progress TEXT, last_activity_at DATETIME, created_at DATETIME
);
CREATE TABLE people (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, relationship TEXT,
  identifiers TEXT, autopilot_status TEXT DEFAULT 'off'
);
```

## Facts API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/internal/facts` | List all user-facing facts (system keys filtered) |
| `POST` | `/internal/facts` | Upsert a fact with optional `category`, `confidence`, `source`, `pinned` |
| `DELETE` | `/internal/facts/:key` | Delete a fact by key |
| `POST` | `/internal/facts/:key/pin` | Toggle pin status (`{ pinned: true/false }`) |

All mutations broadcast a `facts:update` socket event for live UI updates.
