# Spec 032: Local RAG Integration for Life Vaults

## Context
"Life Vaults" allow users to organize files by topic. Currently, there is no semantic search for these files. We have a `RagService` (SQLite + Embeddings), but it's disconnected from Vaults matching logic.

## Goal
Integrate `RagService` with `VaultExecutor` to provide:
1.  **Auto-Ingestion**: Files added to a vault are automatically indexed.
2.  **Scoped Search**: Searching documents restricts results to the active vault context.
3.  **Self-Healing**: A nightly job scans vaults and indexes missing files.

## Architecture

### Database (`rag.db`)
Modify `documents` table:
```sql
ALTER TABLE documents ADD COLUMN vault_id TEXT DEFAULT NULL;
```

### Components

#### 1. Agent Service (`RagService`)
- **Ingestion**: `ingestDocument(path, vaultId)`
    - Stores `vaultId` in `documents` table.
- **Search**: `search(query, vaultId)`
    - If `vaultId` is provided, add `WHERE vault_id = ?` clause.
    - If `vaultId` is null, search all (or configurable global search).

#### 2. Vault Executor (`VaultExecutor`)
- **Hook**: Inside `addToVault`, triggers `agent.ragService.ingestDocument`.

#### 3. Scheduler
- **Job**: `nightly_rag_scan`
- **Logic**:
    - Iterate `/app/data/vaults/{topic}/files`.
    - Check if file hash exists in `rag.db`.
    - If missing, ingest.
    - Prune records for files that no longer exist.

## User Experience
- **User**: "Add this receipt to health vault."
- **Agent**: Adds file -> Vaults switches context -> **RAG Indexes file**.
- **User**: "How much did I pay?"
- **Agent**: Calls `searchDocuments(query, vaultId='health')` -> Returns semantic match from receipt.

## Constraints
- **Performance**: vector search is brute-force JS (acceptable for <10k chunks).
- **File Types**: Initial support for Text and PDF.
