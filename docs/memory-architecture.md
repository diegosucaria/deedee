# Memory Architecture

DeeDee's memory system has three layers that work together: **KV Facts**, **Journal**, and **RAG**.

## Architecture Overview

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
                    │ searchMemory │  Hybrid: Vector + FTS5
                    └──────────────┘
```

## Components

### 1. KV Facts Store (`SQLite facts table`)
- **What**: Durable key-value pairs about the user (preferences, relationships, settings)
- **Keys**: snake_case. Temporal facts use `_on_YYYY-MM-DD` suffix
- **Protected keys**: `user_name`, `agent_name` cannot be overwritten by consolidation
- **Access**: Agent tools `setKey` / `getKey` / `searchMemory`

### 2. MEMORY.md (`data/MEMORY.md`)
- **What**: Auto-generated markdown file listing all KV facts
- **Rebuilt**: Every time facts change (consolidation, pruning, manual edit)
- **Embedded**: Into RAG with vault `memory`
- **Format**: `- **key**: value` per fact

### 3. Journal (`data/journal/YYYY-MM-DD.md`)
- **What**: Daily append-only log of summaries, notes, and events
- **Written by**: Consolidation (daily summaries), `logJournal` tool (manual notes)
- **Embedded**: Into RAG with vault `journal` (files ≥ 200 chars only)
- **Filter**: Short entries (system noise like "No messages found") are skipped

### 4. RAG (Retrieval-Augmented Generation)
- **DB**: `data/rag.db` (SQLite with FTS5)
- **Embedding**: Gemini `text-embedding-004`
- **Search**: Hybrid — 70% vector cosine similarity + 30% BM25 keyword boost
- **Chunking**: 1000-char sliding window, 200-char overlap

## Nightly Schedule

| Time | Job | What |
|------|-----|------|
| 2:00 AM | `nightly_consolidation` | Summarize yesterday's chats → journal + facts |
| 3:00 AM | `nightly_rag_scan` | Re-embed vaults, journals, and MEMORY.md |
| 4:00 AM | `nightly_memory_pruning` | Delete stale temporal facts (>7 days old) |
| 4:30 AM | `nightly_dream` | Creative synthesis from recent memories |

## Data Flow: "What did I do last Tuesday?"

1. User asks question → Agent calls `searchMemory`
2. RAG hybrid search across all vaults (memory, journal, user vaults)
3. Returns top-5 chunks ranked by cosine + BM25 score
4. Agent uses chunks as context to answer
