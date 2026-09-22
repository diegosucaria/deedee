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
- **WhatsApp messages**: held by the interfaces service. The agent asks for one day at a time over `GET /internal/whatsapp/messages-by-date` (bearer `DEEDEE_INTERNAL_TOKEN`); it does not mount the WhatsApp volume.
- **RAG DB**: `/app/data/rag.db` (document chunks + vector embeddings)
- **Volume**: `agent-data` (Docker volume, preserved across rebuilds)

## Memory Types

### 1. Episodic Memory (Chat History)
- **Tables**: `chat_sessions`, `messages`
- **Content**: All user messages and assistant replies grouped by session
- **Who owns a session**: `chat_sessions.source` says which interface the chat belongs to (`web`, `whatsapp`, `telegram`, `slack`, `scheduler`, `subagent`, `api`). The dashboard sidebar lists `source = 'web'` only. The column is set when the session is created; rows written before it existed are filled in at boot. An id that names its owner (`@`, `scheduled_`, `subagent-`, all digits) decides first, then the source of the first message, and an id with the web shape falls back to `web`. A source we do not know, such as a phone shortcut, counts as the owner's own chat and stays in the list. Before this column the list read the id shape, so a web chat that had been handed a Slack channel id (see below) dropped out of the sidebar. `SESSION_SOURCE_FILTER=0` goes back to the old id rule.
- **New Chat reuses an empty chat**, so clicking it twice does not leave a trail of blank rows. It only reuses a session whose `source` is `web`: Deedee creates a session row for every Slack channel it reads, and those rows are empty, so without the check a new web chat was written into a Slack channel's history.
- **Dates**: `created_at` and `updated_at` are ISO UTC (`2026-09-22T17:06:14.000Z`). Every comparison against them uses the same form: SQLite reads these as text, and `datetime('now')` writes `2026-09-22 17:06:14`, which compares as smaller than any ISO date. That is why the empty-session cleanup, which reads `created_at`, deleted nothing for chats made the same day. A new message moves its chat's `updated_at` forward (`touchSession`), never backwards, so the sidebar groups a chat by its last activity.
- **Context Management**: `summaries` table tracks sliding-window summaries (`smart-context.js`) injected into prompts without passing full raw history
- **Old tool results are shortened in the window** (`SmartContextManager.trimOldToolResults`). The window is the newest 50 rows (20 on FLASH), and on the device about 80% of it was old tool results: one stale `listJobs` result of 42,000 characters was 62% of a chat's history, sent again on every call for days. The last 3 rows of results stay whole; calls made at once answer in one row, so they stay together. An older result over 1,500 characters keeps its first 400, a `…[cut]` mark, and a note that says how long it was. The note says to fetch the rest with a read-only call, never to repeat an action (a send, a booking, a push) just to see its result, and never to send or quote the preview as if it were whole. The call and its response both stay, so the pairing the API checks holds. A result marked untrusted stays an untrusted envelope: only its `content` is cut, and our note sits outside it as `shortenedNote`. A plain result is judged with `classifyToolResult` before the cut, with its MCP server name, and a third-party one is wrapped as untrusted. This matters for `searchMemory` and sub-agent reports, whose verdict is read from the body. The gate's own one-key `info` or `error` text is left whole, so it still reads as ours. A list shows the start of each of its first 10 entries, not 400 characters of the first. The summary trigger (`estimateTokens`) still measures the stored window: measured after the cut, a chat full of tool results never got a summary again. The stored rows are not changed: the chat page and the history search show every result in full. `HISTORY_TRIM=0` turns it off.

### 2. Semantic Memory (KV Facts)
- **Table**: `kv_store`
- **Content**: Key-value pairs with metadata for long-term storage (preferences, relationships, settings)
- **Schema**: `key TEXT PRIMARY KEY, value TEXT, category TEXT, confidence TEXT, source TEXT, created_at DATETIME, pinned INTEGER, updated_at DATETIME, kind TEXT, summary TEXT, last_used_at DATETIME, use_count INTEGER`
- **Kind**: `profile` (durable facts about the owner and his people), `note` (what the agent learned about doing its job), `state` (job bookkeeping, notification flags, Node-RED dumps). Stored when a tool or the consolidator says so; otherwise read from the key and the category (`factKind` in `db.js`), so it works for rows written before the column existed.
- **Categories**: `preference`, `relationship`, `temporal`, `system`, `general`
- **Confidence levels**: `user_explicit` (stated by user), `consolidated` (extracted by LLM), `inferred` (system-derived)
- **Sources**: `manual` (dashboard), `tool` (rememberFact), `consolidation` (nightly), `system`
- **Pinning**: Facts can be pinned (via dashboard or API) to protect from auto-pruning and consolidation overwrite
- **Agent Access**: `rememberFact(key, value, kind?, summary?)`, `updateFact(key, value, summary?, force?)`, `forgetFact(key, force?)`, `getFact(key)`, `searchMemory(query)`. `updateFact` and `forgetFact` write only on an exact key; a near key comes back as a candidate to call again with, and several come back as a list. `force: true` is needed for a pinned fact on either tool, and by `forgetFact` for a fact about the owner. They live in `utils/fact-tools.js`, so a voice call reaches them through the tool executor as well as a chat through the agent.

### The facts index (what the prompt carries)
Every turn used to carry every fact in full: on the device, 642 rows, about 56,000 characters, roughly 14,000 tokens of a 45,000-token chat turn. `db.getFactsIndex()` now renders the block in two tiers inside one budget of 24,000 characters (`FACTS_INDEX_CHARS`, a plain number, clamped to 2,000–60,000):

1. **With values**: the facts nearest the top of the order carry a one-line value (80 characters).
2. **Names only**: every other key is still printed, under `ALSO STORED`. The model can read any of them in full with `getFact(key)` instead of guessing whether the fact exists.

Naming every key costs about 17,000 characters on the device, so most of the budget buys reach and the rest buys detail. That is deliberate: one-lining the values saves only about 8% on his data (only a quarter of his values are longer than 80 characters), so a smaller budget would not have been a cheaper format, only a smaller memory. When even the names do not fit, the block falls back to as many value lines as fit plus a count of the rest.

- **Order**: pinned first, the owner's profile before the agent's notes, newest first, then the key. Nothing in the order depends on what was read lately, so the block stays byte-identical while the facts do not change and the cached prefix survives. The old renderer varied with the turn (it hid Node-RED facts unless the turn mentioned them), which broke that.
- **Left out**: `state` keys (`job:`, `notified_`, `config:`, `sys_`, `sch_`, `system_web_navigator_`, Node-RED and Home Assistant dumps), dated keys older than five days, and anything past the budget. `system_` keys are ordinary facts, not state. All of it stays in the table, and `getFact` or `searchMemory` still reach it. `searchMemory` searches facts as well as chats and documents, word by word, so a two-word question finds the fact that holds both.
- **A changed value drops a summary written for the old one**, so the block can never state a value that has been corrected. The `kind` describes the key, not the value, so it survives a new value: losing it would move the fact to another section and drop the guard that makes `forgetFact` ask first.
- **Writing asks when it should.** `forgetFact` carries a confirmation flag and counts as deleting the owner's data for the guardian; a copy of the fact goes to `data/pruned_memories.json` first, and so does the old value of an `updateFact`. A damaged backup file is renamed aside, never overwritten. `updateFact` and `forgetFact` match by key only, so a word in another fact's value can never rewrite or delete it. A pinned fact needs `force: true` on either tool (both declare it), `rememberFact` refuses to write over a pinned key, and `forgetFact` refuses a `state` key outright.
- **Searching takes keywords, not questions.** `findFacts` strips punctuation and the grammar words of both languages before matching, so "What is my home city?" reaches the same row as "home city", and a plain plural finds the singular the key uses ("car tyres" reaches `user_car_tyre_size`). Every word must appear; when no fact holds them all, the rows holding the most come back instead of nothing. `state` rows stay out of a search as well as out of the prompt, and a searched value is cut to 600 characters, so one machine dump cannot fill the turn. The write tools skip the loose fallback and act on an exact key only.
- **Use tracking**: `getFact` and a `searchMemory` hit bump `use_count` and `last_used_at`. They are bookkeeping for the memory page and do not change the order of the block: reordering on use would throw away the cached prefix every turn.
- **Escape hatch**: `FACTS_INDEX=0` brings the full dump back.
- **The live voice prompt** uses the same renderer with its own smaller budget (`MAX_FACTS_CHARS`, 6,000), because the whole voice instruction has to fit in 12,000 characters. The facts take what is left after the rules, the recall line and the owner's style, so they can never push those off the end.
- **RAG Sync**: Facts are synced to `data/MEMORY.md` and embedded into RAG (vault: `memory`) by `nightly_consolidation` at 2 AM, and only when that run learned at least one fact. The 3 AM scan reads the vaults and the journal folder; it never touches `MEMORY.md`.
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
- **Content**: Multi-session work the AGENT is executing that must survive a restart. NOT for user TODOs — those become a reminder (`setReminder` for one time, `scheduleJob` for a repeat, `scheduleTask` when something must be done at that time) or stay as chat responses.
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
1. **Chat history**: `db.searchMessages(query)` — ranked full-text search through stored messages (see below)
2. **RAG**: `ragService.search(query)` — hybrid vector + FTS5 across every vault (journal, memory, user vaults) except the ones marked private
3. Returns both as `{ chat_history, knowledge }` so the agent can reason across sources

This call names no vault, and it runs on any turn where the agent looks something up. A vault marked private stays out of it; a search that names the vault still reads it. See "Private vaults" in `docs/local-rag.md`.

### Chat history search (`utils/messages-fts.js`)
`searchMemory` and `searchHistory` both read stored messages through `db.searchMessages`. It used to be a `LIKE` scan of every row: no ranking, newest first, and a hit inside tool data came back as escaped JSON. It is now an FTS5 index.

- **Two columns.** `body` is what was said: the message text, `[tool: name]` for a call, `[image attached]` and the like for attachments. `tool` is what tools took and returned: `[tool call: name]` with the call's arguments, `[tool result: name]` with the result, 2,000 characters each. A call's arguments are often the only stored copy of what the agent sent to a contact. `bm25` weighs `body` at 1.0 and `tool` at 0.25, so a chat line outranks a tool dump that holds the same word. A picture never enters the index. An untrusted envelope is indexed by its `content`, not by our note.
- **Triggers, in SQL only.** `messages_fts_ai`, `messages_fts_au` and `messages_fts_ad` keep the index in step with every writer. Parts that are not valid JSON index as empty text; they never stop a message from being saved.
- **A map table.** `messages.id` is text, so its rowid can change in a `VACUUM`. `messages_fts_map(fts_id, msg_id)` gives each message a stable integer id, and a delete finds its index row without a scan.
- **Old rows.** After boot the rows that were there before are indexed 500 at a time (`setImmediate` between batches). `agent_settings.messages_fts_backfilled` marks the end. Until then search uses the old scan. A boot cut short carries on at the next one.
- **A fingerprint.** SQLite keeps a trigger's text as first created. `agent_settings.messages_fts_schema` holds a hash of the indexing SQL; when it differs at boot, or the index was emptied by hand, the index is dropped and built again. So an edit to `columnsSql` needs no migration.
- **Words.** Each word typed becomes one quoted phrase, so nothing in a query is read as FTS5 syntax and `17.4.1.5` or `AB-1234` keep all their pieces. Accents and case do not matter. The index has no stemming, so a plain word of four letters or more also matches as a prefix: `tyre` finds `tyres`, `reunion` finds `reuniones`. A number never does: `50` must not find `500`. Over 12 words, the shortest are dropped.
- **Four passes, one answer.** (1) The exact phrase, best first, for up to half the answer. (2) The newest rows where the words were said (`body` only), for up to half: `bm25` favours short rows, and on a topic that comes back often it buried yesterday's long message. (3) Every word, best first, to fill what is left. (4) Any one word, only when pass 2 found nothing said, so a stray hit in a tool dump does not end the search. When the index finds nothing at all the old scan runs, because it also matches inside a word.
- **Results.** Each match is an excerpt of about 48 words around the hit, at most 400 characters.
- **`searchHistory`** looks in the current chat first and fills the rest of the limit from other chats, marked `(another chat)`. With an answer from this chat in hand, the other chats are asked through the index only. It takes `from` and `to` as local days, `YYYY-MM-DD`.
- **`MESSAGES_FTS=0`** drops the index, the map and the triggers at boot, and search goes back to the scan. Setting it back to 1 rebuilds the index from the table. Use it if the index is ever damaged: a failing trigger would stop messages from being saved.
- **Known limits.** Clearing all history fires the delete trigger once per row: about 0.4 s for 41,000 rows on a desktop, a couple of seconds on the Pi. Both search tools reach every chat, as they did before the index; keeping runs for other people out of the owner's chats is a separate change.

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
| 3:00 AM | `nightly_rag_scan` | Index changed vault files, vault pages and journal days; drop the ones deleted from disk |
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
