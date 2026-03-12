# Feature: Local RAG (Retrieval Augmented Generation)

## Overview
Deedee now has a Local RAG system integrated with **Life Vaults**. This allows the agent to semantically search your files to answer questions.

## How it Works
1.  **Vault-Scoped**: RAG is currently designed to work within **Life Vaults**.
    *   Files added to a vault are automatically indexed (chunked and embedded).
    *   Searching is **scoped** to the active vault. If you are in the "Finance" vault, the agent only searches finance documents.
2.  **Auto-Ingestion**: When you use the "Add to Vault" feature, the file is immediately indexed.
3.  **Nightly Scan**: A job runs every night at 3 AM to find any files you might have manually dropped into the vault folders and indexes them.

## Supported File Types
Deedee uses `gemini-embedding-2-preview` for multimodal embeddings, supporting:

| Type | Extensions | How it works |
|------|-----------|--------------|
| **Text** | `.txt`, `.md`, etc. | Chunked into 2K-char segments, embedded as text |
| **PDF** | `.pdf` | Dual embedding: text extracted for keyword search (FTS) + native PDF embedding for visual/layout understanding |
| **Images** | `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` | Single native multimodal embedding per file |
| **Audio** | `.wav`, `.mp3`, `.ogg`, `.opus` | Single native multimodal embedding per file |
| **Video** | `.mp4`, `.mov` | Single native multimodal embedding per file (up to 120s) |

**Cross-modal search**: Text queries can find relevant images, audio, and video files. All modalities share the same vector space.

**File size limit**: 20MB max for multimodal files (images, audio, video).

## Commands
*   `/rescan`: Manually triggers a scan of all vaults to ingest missing files immediately.

## Monitoring
You can view the status of the RAG index in **System > Stats**:
*   **Total Documents**: Number of files indexed.
*   **Content Types**: Breakdown of text, image, audio, video, and PDF chunks.

## 💬 Vault Chat (Contextual RAG)
You can speak directly to a Vault's context using the sidebar in the **Vault Detail Page** (`/vaults/[id]`). This chat session is:
*   **Context-Aware**: The agent knows it is chatting about *this specific vault* and will prioritize using RAG to answer questions.
*   **Conversation History**: History is preserved for that vault session.
*   **Inline Viewing**: Any files referenced or available in the vault can be viewed inline by clicking the "View" icon.

## FAQ

**Q: Is RAG only for Vaults?**
A: Currently, yes. This is a design choice to keep context clean. The agent knows *where* to look based on what you are talking about. Global search over messy folders often leads to hallucinations or irrelevant results.

**Q: What happens if I upload a random document outside a vault?**
A: It will **not** be indexed by default. The RAG system watches specific vault directories.

**Q: Can I just upload files without chat context?**
A: Yes! You can drop files directly into `data/vaults/{topic}/files/` on the file system. The nightly scan (or `/rescan`) will pick them up. This is useful for building a "Knowledge Base" for the agent—dropping in PDFs of manuals, receipts, or notes that you want the agent to be able to reference anytime you enter that context.

**Q: What embedding model is used?**
A: `gemini-embedding-2-preview` with configurable Matryoshka dimensions (768, 1536, or 3072). Set the `EMBEDDING_DIMENSIONS` environment variable to change. Default is 768 for backward compatibility; production uses 1536.

**Q: What happens if I change the embedding dimensions?**
A: The system automatically detects dimension changes on startup, clears incompatible embeddings, and re-indexes documents on the next nightly scan. No manual intervention needed.
