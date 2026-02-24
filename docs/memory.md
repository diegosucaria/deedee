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
- **Content**: Key-value pairs for long-term storage (preferences, relationships, settings)
- **Agent Access**: `rememberFact(key, value)`, `getFact(key)`
- **Protected Keys**: `user_name`, `agent_name` cannot be overwritten by consolidation
- **RAG Sync**: Facts are synced to `data/MEMORY.md` and embedded into RAG (vault: `memory`)
- **Pruning**: Nightly job uses Gemini to cull stale/obsolete facts, backed up to `data/pruned_memories.json`

### 3. Journal (Daily Summaries)
- **Files**: `data/journal/YYYY-MM-DD.md` (append-only)
- **Content**: Consolidation summaries, manual notes, events
- **Agent Access**: `logJournal(text)` (write), `readJournal(date)`, `searchJournal(query)` (internal)
- **RAG Sync**: Embedded into RAG (vault: `journal`), files under 200 chars are skipped (system noise)
- **Automation**: `nightly_consolidation` at 2AM, manual via `/consolidate`

### 4. Intentional Memory (Goals)
- **Table**: `goals`
- **Content**: Persistent tasks/intentions spanning sessions and restarts
- **Solves**: The "Amnesia Problem" — on boot, agent checks pending goals and resumes

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

## Nightly Schedule

| Time | Job | Description |
|------|-----|-------------|
| 2:00 AM | `nightly_consolidation` | Summarize yesterday's chats → journal + facts |
| 3:00 AM | `nightly_rag_scan` | Re-embed vaults, journals, and MEMORY.md |
| 4:00 AM | `nightly_memory_pruning` | Delete stale temporal facts (>7 days old) |
| 4:30 AM | `nightly_dream` | Creative synthesis from recent memories |

## Self-Improvement Workflow
1. **Plan**: Agent decides to add a feature
2. **Persist**: Creates a goal via `db.updateGoal`
3. **Execute**: Instructs Supervisor to update codebase
4. **Restart**: Supervisor pushes → Balena updates → container restarts
5. **Resume**: Agent reads goals table and resumes pending work

## Schema Reference
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY, role TEXT, content TEXT,
  source TEXT, chat_id TEXT, timestamp DATETIME, metadata TEXT
);
CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL,
  content TEXT NOT NULL, range_end TEXT, summary_tokens INTEGER
);
CREATE TABLE goals (
  id INTEGER PRIMARY KEY, description TEXT, status TEXT, metadata TEXT
);
CREATE TABLE people (
  id TEXT PRIMARY KEY, name TEXT, phone TEXT, relationship TEXT,
  identifiers TEXT, autopilot_status TEXT DEFAULT 'off'
);
```
