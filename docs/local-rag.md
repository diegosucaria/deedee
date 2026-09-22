# Local RAG Architecture

Deedee uses **Retrieval-Augmented Generation (RAG)** to provide "Long-Term Memory" capabilities. This allows the agent to answer questions based on your personal files (stored in Vaults) without needing to context-stuff the entire document into the prompt.

## Core Concepts

### 1. Documents & Chunks
Large files (like PDFs or Markdown notes) are too big for a single prompt. We break them down into smaller pieces called **Chunks** (e.g., ~1000 characters).

### 2. Embeddings (Vectors)
We use the Google Gemini Embedding API to convert each text chunk into a **Vector** (a list of 768 numbers).
- **Semantics**: The vector represents the *meaning* of the text, not just the keywords.
- **Model**: Default is `text-embedding-004`, but this is configurable.

### 3. Vector Database
We store these vectors locally in a SQLite database (`data/rag.db`) using a `BLOB` column. This keeps your data private on the device (except for the API call to generate the vector itself).

## Configuration

You can configure the embedding model via environment variables in `.env`:

```bash
# Default: text-embedding-004
GEMINI_EMBEDDING_MODEL=text-embedding-004
```

Other supported models (check Google AI Studio for availability):
- `gemini-embedding-001`

## Implementation Details

### Task Types
To improve accuracy, we specify the `taskType` when calling the API:
- **`RETRIEVAL_DOCUMENT`**: Used during **Ingestion**. Tells the model "This text is a document to be searched later."
- **`RETRIEVAL_QUERY`**: Used during **Search**. Tells the model "This text is a question/query looking for answers."

### Workflow
1.  **Ingestion**:
    - File added to `vaults/<topic>/files/`.
    - `RagService` reads file -> Chunks text.
    - Calls API with `RETRIEVAL_DOCUMENT` -> Gets Vector.
    - Saves Vector + Text to SQLite.

2.  **Retrieval (Search)**:
    - User asks question.
    - `RagService` calls API with `RETRIEVAL_QUERY` -> Gets Query Vector.
    - Calculates **Cosine Similarity** between Query Vector and all Stored Vectors.
    - Returns top 5 most similar chunks.

3.  **Generation**:
    - Agent inserts top chunks into the prompt ("Context: ...").
    - LLM answers the user using that context.

## When an embedding fails

`ingestDocument` writes the document's row before it embeds the chunks. Until 2026-09-22 the row carried the file's hash from the start. So a file whose embedding failed (a network error, a rate limit, a PDF that would not parse) looked indexed to the next scan, and it never got a vector.

A failed pass now clears the hash (`rag-service.js`, `_recordOutcome`), and the next nightly scan indexes the file again. On a retry the old chunks stay until every new one has embedded, the way a model change re-embeds (`_reembedDocument`). A bad night never empties a document that was searchable the night before.

After three failed passes in a row (`failed_attempts` on the row) the scan stops trying and the owner gets a notification (`rag_ingest_failed`). The row takes the file's hash, and search keeps whatever chunks the row already has, if any. The counter goes back to zero on a complete pass, including one from `reindexEmbeddings`, and a changed file (`tried_hash` differs) starts its own run of tries. A new row carries no hash until its first pass succeeds, so a process killed mid-pass leaves nothing that looks indexed. `RAG_MAX_INDEX_ATTEMPTS` sets the number; `0` means never stop trying.

A vault name must hold at least one letter or digit. A name of only dots or symbols used to sanitise to an empty string, and `deleteVault` on it would have removed the whole vaults folder (`vault-manager.js`, `sanitizeTopic`).

## When a file is deleted

The nightly scan used to only add. A file taken out of a vault kept its chunks, so search went on quoting a document that was no longer on disk.

`pruneMissingDocuments` (`rag-service.js`) now runs at the end of each scan. For every indexed file that has left the disk it deletes the chunks, the matching `chunks_fts` and `chunks_vec` rows and the `documents` row, and the scan logs how many it dropped. It only looks at documents under the folder it has just scanned — `vaults/` after `scanAndIngest`, the journal folder after `scanJournals` — and the caller has already checked that folder is there. So an unmounted data volume prunes nothing.

`RAG_PRUNE_MISSING=0` turns the pruning off and gives back the old behaviour. The value is read on every call.

## Private vaults

`searchMemory` is a core tool: it runs on any turn where the agent looks something up, and it searches every vault at once. That put the owner's medical notes in reach of a question nobody asked about them.

A vault can now be marked **private** on its page in the web app (the Private switch in the header). The flag lives in `agent_settings` as `vault_private:<id>`, and every vault starts searchable.

What changes:

- A search with no vault named skips the private ones. That is `searchMemory` on every turn, and `searchDocuments` in a chat that has no active vault.
- A search that names a vault still reads it. So `searchDocuments` in a chat whose active vault is the private one works as before, and so does opening that vault's chat pane in the web app.
- Nothing else changes: the vault is still indexed, still on the page, still readable with `readVaultPage` and `readVaultFile`. Private means "stay out of the sweep", not "hidden".

The route is `POST /v1/vaults/:id/private` with `{ "private": true }`, behind the internal token like every other agent route, with the gateway and the `setVaultPrivate` Server Action in front.

`VAULT_PRIVACY=0` turns the whole idea off and searches every vault again. The value is read on every call.

