# Feature: Local RAG (Retrieval Augmented Generation)

## Overview
Deedee now has a Local RAG system integrated with **Life Vaults**. This allows the agent to semantically search your files to answer questions.

## How it Works
1.  **Vault-Scoped**: RAG is currently designed to work within **Life Vaults**.
    *   Files added to a vault are automatically indexed (chunked and embedded).
    *   Searching is **scoped** to the active vault. If you are in the "Finance" vault, the agent only searches finance documents.
2.  **Auto-Ingestion**: When you use the "Add to Vault" feature, the file is immediately indexed.
3.  **Nightly Scan**: A job runs every night at 3 AM to find any files you might have manually dropped into the vault folders and indexes them.

## Commands
*   `/rescan`: Manually triggers a scan of all vaults to ingest missing files immediately.

## Monitoring
You can view the status of the RAG index in **System > Stats**:
*   **Total Documents**: Number of files indexed.
*   **Index Size**: Size of the vector database.
*   **Vault Distribution**: How many docs per vault.

## FAQ

**Q: Is RAG only for Vaults?**
A: Currently, yes. This is a design choice to keep context clean. The agent knows *where* to look based on what you are talking about. Global search over messy folders often leads to hallucinations or irrelevant results.

**Q: What happens if I upload a random document outside a vault?**
A: It will **not** be indexed by default. The RAG system watches specific vault directories.

**Q: Can I just upload files without chat context?**
A: Yes! You can drop files directly into `data/vaults/{topic}/files/` on the file system. The nightly scan (or `/rescan`) will pick them up. This is useful for building a "Knowledge Base" for the agent—dropping in PDFs of manuals, receipts, or notes that you want the agent to be able to reference anytime you enter that context.
