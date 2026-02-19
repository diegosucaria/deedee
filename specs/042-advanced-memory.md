# Spec 042: Advanced Memory & Vector Search

## Goal
Upgrade DeeDee's memory system from basic SQLite regex search to proper vector-powered semantic search. The agent should be able to recall conversations, facts, and documents by meaning — not just keywords. This also unifies the separate `searchMemory`, `searchHistory`, and RAG search systems into one coherent memory layer.

## Background

### Current State
DeeDee has **three separate search systems** that don't talk to each other:

1. **`searchMemory`** (`MemoryExecutor` → `db.searchMessages()`): SQL `LIKE` search over `messages` table. Keyword-only, no semantic understanding.
2. **`searchHistory`**: Similar SQL search with different filters. Overlaps with `searchMemory`.
3. **RAG Search** (`RagService.search()`): Vector search over **documents only** (Life Vaults). Uses Gemini embeddings + cosine similarity in SQLite. Separate `rag.db` database.

### Problems
- **No semantic search over conversations.** "What did I say about vacation?" fails if the word "vacation" wasn't used (maybe "trip to Italy" was used instead).
- **Duplicate/overlapping tools.** `searchMemory` and `searchHistory` confuse the agent — which one to use?
- **Separate databases.** `agent.db` for conversations, `rag.db` for documents. No unified search.
- **No recency bias.** A fact from 6 months ago ranks the same as one from yesterday.
- **No diversity.** If 5 results all say the same thing, the agent gets repetitive context.

### OpenClaw's Approach
OpenClaw's memory system (78 source files) has:
- Multiple embedding providers (Voyage, Gemini, OpenAI).
- Hybrid search (vector similarity + keyword BM25).
- MMR (Maximal Marginal Relevance) for result diversity.
- Temporal decay (newer matches rank higher).
- QMD (Query-Memory-Document) query parser.
- Batch embedding operations.

We'll take the best ideas and adapt them for DeeDee's simpler SQLite-based architecture.

## Architecture

### Unified Memory Store
Merge everything into a single vector-capable database. We'll extend `rag.db` into `memory.db` (or keep it as `rag.db` with new tables).

```sql
-- Unified embeddings table
CREATE TABLE IF NOT EXISTS memory_vectors (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,        -- 'conversation', 'fact', 'document', 'journal'
  source_id TEXT,              -- message ID, fact key, document chunk ID
  content TEXT NOT NULL,       -- the text that was embedded
  embedding BLOB NOT NULL,     -- float32 array as buffer
  metadata TEXT,               -- JSON: { chatId, role, timestamp, vaultId, ... }
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_vectors(source);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_vectors(created_at);
```

### Embedding Pipeline
Reuse and enhance the existing `RagService._getEmbedding()` which already uses Gemini Embeddings.

```
Input Text → Chunking → Gemini Embedding API → Float32 Array → SQLite BLOB
```

### Search Pipeline

```
User Query
    ↓
┌─────────────────────────────┐
│ 1. Embed Query              │  (Gemini Embeddings, RETRIEVAL_QUERY)
│ 2. Vector Search (Top 20)   │  (Cosine similarity in SQLite)
│ 3. Keyword Boost (Optional) │  (Boost results that also match keywords)
│ 4. Temporal Decay            │  (Newer results get score bonus)
│ 5. MMR Reranking (Top K)    │  (Diversify final results)
└─────────────────────────────┘
    ↓
Final Results (Top 5-10)
```

## Implementation Plan

### Phase 1: Vector Search Engine

#### `apps/agent/src/services/memory-search.js` [NEW]

Core semantic search service:

```javascript
class MemorySearchService {
  constructor(agent) {
    this.agent = agent;
    this.ragService = agent.ragService; // Reuse embedding infrastructure
    this.db = null; // Will use the RAG database
  }

  // Embed a text into a float32 array
  async embed(text, taskType = 'RETRIEVAL_DOCUMENT') {
    return this.ragService._getEmbedding(text, taskType);
  }

  // Search across all memory sources
  async search(query, options = {}) {
    const {
      sources = ['conversation', 'fact', 'document', 'journal'],
      limit = 10,
      minScore = 0.3,
      temporalDecay = true,
      mmr = true,
      mmrLambda = 0.7,  // 0=max diversity, 1=max relevance
      vaultId = null
    } = options;

    // 1. Embed the query
    const queryVec = await this.embed(query, 'RETRIEVAL_QUERY');

    // 2. Get all candidates from requested sources
    const candidates = this._getCandidates(sources, vaultId);

    // 3. Score by cosine similarity
    const scored = candidates.map(c => ({
      ...c,
      score: cosineSimilarity(queryVec, c.embedding)
    })).filter(c => c.score >= minScore);

    // 4. Apply temporal decay
    if (temporalDecay) {
      this._applyTemporalDecay(scored);
    }

    // 5. Sort by score
    scored.sort((a, b) => b.score - a.score);

    // 6. Apply MMR for diversity
    if (mmr) {
      return this._mmrRerank(scored, queryVec, limit, mmrLambda);
    }

    return scored.slice(0, limit);
  }
}
```

#### Temporal Decay
Newer memories get a boost. Adapted from OpenClaw's `temporal-decay.ts`:

```javascript
_applyTemporalDecay(results) {
  const now = Date.now();
  const DAY_MS = 86400000;
  
  for (const r of results) {
    const age = now - new Date(r.created_at).getTime();
    const ageDays = age / DAY_MS;
    
    // Half-life of 30 days: score multiplied by 0.5 after 30 days
    const decay = Math.pow(0.5, ageDays / 30);
    
    // Blend: 80% relevance + 20% recency
    r.score = 0.8 * r.score + 0.2 * decay;
  }
}
```

#### MMR (Maximal Marginal Relevance)
Prevents returning 5 near-identical results. Adapted from OpenClaw's `mmr.ts`:

```javascript
_mmrRerank(candidates, queryVec, k, lambda) {
  const selected = [];
  const remaining = [...candidates];
  
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    
    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      
      // Max similarity to already-selected results
      const maxSimilarity = selected.length === 0 ? 0 :
        Math.max(...selected.map(s => 
          cosineSimilarity(remaining[i].embedding, s.embedding)
        ));
      
      // MMR score: balance relevance vs diversity
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }
    
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  
  return selected;
}
```

### Phase 2: Embedding Pipeline (Indexing)

#### Automatic Conversation Indexing
After each agent turn, embed the user message and agent reply:

```javascript
// In agent.js, after processMessage completes:
if (this.memorySearch) {
  // Don't block the response — index in background
  setImmediate(async () => {
    try {
      await this.memorySearch.indexConversation(chatId, userMessage, agentReply);
    } catch (err) {
      console.error('[Agent] Memory indexing failed:', err.message);
    }
  });
}
```

#### Batch Indexing for Existing Data
One-time migration script to embed existing conversations and facts:

```javascript
async indexExistingData() {
  // 1. Index all facts
  const facts = this.agent.db.getAllFacts();
  for (const fact of facts) {
    await this.index({ source: 'fact', content: `${fact.key}: ${fact.value}`, ... });
  }
  
  // 2. Index conversation summaries (from summaries table)
  // Don't index every raw message — too much. Index summaries.
  const summaries = this.agent.db.getAllSummaries();
  for (const s of summaries) {
    await this.index({ source: 'conversation', content: s.summary, ... });
  }
  
  // 3. Documents already indexed via RAG — migrate to unified table
}
```

#### Incremental Indexing
- New messages: indexed in background after each turn.
- New facts: indexed on `rememberFact` tool call.
- New documents: indexed on vault file add (existing RAG pipeline).
- Journal entries: indexed on `logJournal` tool call.

### Phase 3: Unified Search Tool

Replace `searchMemory` and `searchHistory` with a single powerful tool:

```javascript
{
  name: "searchMemory",
  description: "Semantic search across ALL of the agent's memory: conversations, facts, documents, and journal entries. Use this to recall anything — past conversations, stored facts, ingested documents. Understands meaning, not just keywords.",
  parameters: {
    type: "OBJECT",
    properties: {
      query: { type: "STRING", description: "What to search for. Can be a question or topic." },
      sources: {
        type: "ARRAY", items: { type: "STRING" },
        description: "Optional filter: ['conversation', 'fact', 'document', 'journal']. Default: all."
      },
      limit: { type: "NUMBER", description: "Max results (default 5)." },
      recency: { type: "STRING", description: "Optional time filter: 'today', 'this_week', 'this_month', 'all'. Default: all." }
    },
    required: ["query"]
  }
}
```

**Backward compatibility:** `searchHistory` becomes an alias for `searchMemory` with `sources: ['conversation']`. The old `searchMemory` handler falls through to the new one.

### Phase 4: Hybrid Search (Keyword Boost)

For queries with specific names, dates, or technical terms, pure vector search might miss exact matches. Add keyword boosting:

```javascript
async search(query, options) {
  // ... vector search ...
  
  // Keyword boost: if a candidate contains exact query words, boost score
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  
  for (const result of scored) {
    const contentLower = result.content.toLowerCase();
    const matchCount = queryWords.filter(w => contentLower.includes(w)).length;
    const keywordBoost = matchCount / queryWords.length * 0.15; // Up to +15% boost
    result.score += keywordBoost;
  }
}
```

### Phase 5: Integration & Migration

1. **Initialize** `MemorySearchService` in `Agent.start()`.
2. **Update** `MemoryExecutor`: Route `searchMemory` to new service, keep old SQL as fallback.
3. **Update** `RagExecutor`: Use new unified search instead of separate RAG search.
4. **Migration**: One-time script to embed existing facts and summaries.
5. **RAG compatibility**: `searchDocuments` still works but now uses the unified system with `sources: ['document']`.

## Performance Considerations

### Raspberry Pi Constraints
- **Embedding calls are slow**: Gemini API round-trip ~200-500ms per call.
- **Batch wisely**: Index in background, batch multiple texts when possible.
- **Cache embeddings**: Never re-embed unchanged text.
- **Limit vector count**: Target <50K vectors for responsive in-memory search.
- **SQLite is fine**: Cosine similarity over 50K 768-dim vectors takes < 500ms on Pi. No need for pgvector.

### Embedding Dimensions
- Gemini `text-embedding-004`: 768 dimensions.
- Storage: 768 × 4 bytes = ~3KB per embedding.
- 50K vectors: ~150MB. Acceptable for Pi with 4-8GB RAM.

## Files Changed

| File | Action | Description |
|---|---|---|
| `apps/agent/src/services/memory-search.js` | NEW | Unified vector search service |
| `apps/agent/src/services/rag-service.js` | MODIFY | Add unified table, migrate indexing |
| `apps/agent/src/executors/memory.js` | MODIFY | Route to new search service |
| `apps/agent/src/executors/rag.js` | MODIFY | Use unified search |
| `apps/agent/src/agent.js` | MODIFY | Init MemorySearchService, background indexing |
| `apps/agent/src/tools-definition.js` | MODIFY | Update searchMemory description |
| `apps/agent/src/db.js` | MODIFY | Add memory_vectors table migration |

## Testing
- **Unit**: Test cosine similarity, temporal decay, MMR reranking with mock vectors.
- **Integration**: Index 100 test messages → search by meaning → verify relevant results returned.
- **Regression**: Existing `searchMemory` calls still work (backward compatibility).
- **Performance**: Measure search latency with 10K, 50K vectors on Pi hardware.
- **Manual**: "What did I say about vacation?" → finds "trip to Italy" conversation (semantic match).
