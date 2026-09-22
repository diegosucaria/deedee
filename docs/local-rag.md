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

`ingestDocument` writes the document's row before it embeds the chunks. Until 2026-09-22 the row carried the file's hash from the start, so a file whose embedding failed (a network error, a rate limit, a PDF that would not parse) looked indexed to the next scan and never got a vector. A failed pass now clears the hash (`rag-service.js`, `_recordOutcome`), and the next nightly scan indexes the file again. On a retry the old chunks stay until every new one has embedded, the way a model change re-embeds (`_reembedDocument`), so a bad night never empties a document that was searchable the night before. After three failed passes in a row (`failed_attempts` on the row) the scan stops trying and the owner gets one notification (`rag_ingest_failed`); `reindexEmbeddings` still forces a full pass.

A vault name must hold at least one letter or digit. A name of only dots or symbols used to sanitise to an empty string, and `deleteVault` on it would have removed the whole vaults folder (`vault-manager.js`, `sanitizeTopic`).

