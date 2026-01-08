# Spec 028: Life Vaults (Deep Context & Knowledge Base)

## 1. Context & Problem
The user wants Deedee to have "Long-Term Knowledge" on specific topics (Health, Finances, etc.) backed by actual files.
Currently, the agent relies on a transient context window and a simple KV store. It lacks a structured way to "read" a folder of documents or maintain a "Wiki" of a person's life.

## 2. Goals
- **Structured Storage**: A filesystem-based approach to store files and markdown summaries per topic ("Vault").
- **Auto-Context Switching**: Detecting key topics (e.g., "Health") and automatically loading the corresponding Vault's knowledge into the Agent's context.
- **File Ingestion**: Agent can receive a file (PDF/Image), analyze it, and effectively "file it" into the correct Vault.

## 3. Architecture

### 3.1. File System Structure
Location: `apps/agent/data/vaults/`
```text
vaults/
├── health/
│   ├── index.md             # The "Wiki" page (AI-maintained)
│   ├── vaccinations.md      # Sub-page (optional, linked from index)
│   └── files/               # Raw assets
│       ├── blood_test_2024.pdf
│       └── scan_001.jpg
├── finance/
│   ├── index.md
│   └── files/
└── ...
```

### 3.2. Data Models
No new SQL tables. We rely on the filesystem.
**Vault Metadata** (derived from FS):
```json
{
  "id": "health",
  "name": "Health",
  "fileCount": 12,
  "lastModified": "2026-01-08T10:00:00Z"
}
```

### 3.3. API Design (`/v1/vaults`)
All endpoints protected by `authMiddleware`.

| Method | Path | Description | Access |
| :--- | :--- | :--- | :--- |
| `GET` | `/vaults` | List all vaults + stats | Private |
| `POST` | `/vaults` | Create a new vault (`{ topic: "recipes" }`) | Private |
| `GET` | `/vaults/:id` | Get `index.md` content + file list | Private |
| `POST` | `/vaults/:id/wiki` | Update markdown content (`{ content: "..." }`) | Private |
| `POST` | `/vaults/:id/files` | Upload file (Multipart) | Private |
| `GET` | `/vaults/:id/files/:filename` | Download file | Private |

### 3.4. Auto-Context Switching Logic
**Trigger**:
1. User uploads file -> Agent calls `addToVault("health", ...)` -> **Session Mode switches to "health"**.
2. User says "Let's talk about health" -> Agent calls `setSessionTopic("health")`.
3. UI Helper: User clicks "Health Vault" in Dashboard -> Starts chat with `topic="health"`.

**Mechanism (`SmartContext`):**
When `session.topic` is set to `health`:
1. Read `data/vaults/health/index.md`.
2. **Inject** into System Prompt:
   ```text
   
   === 📂 ACTIVE VAULT: HEALTH ===
   You are now accessing the user's Health knowledge base.
   
   ## SUMMARY (from index.md):
   ${indexContent}
   
   ## AVAILABLE FILES:
   ${fileList.join(", ")}
   
   ## INSTRUCTIONS:
   - Use this context to answer questions.
   - If you need to see a specific file's details, use 'readVaultFile'.
   - If you receive new information, use 'updateVaultWiki' to keep the index fresh.
   ================================
   ```

## 4. Tools Definition
The Agent will need these tools to manage the vaults autonomously.

- `create_vault(topic: string)`: Create a new vault.
- `list_vaults()`: See what exists.
- `add_to_vault(topic: string, file_path: string, summary: string)`: Move a temp file to the vault and optionally confirm what it is.
- `read_vault_page(topic: string, page: string)`: Read markdown.
- `update_vault_page(topic: string, page: string, content: string)`: Write markdown.
- `list_vault_files(topic: string)`: List raw files.

## 5. Security & Safety
- **Path Traversal**: `VaultManager` must strictly validate `topic` and `filename` to ensure they don't contain `..` or special chars.
- **Private Data**: Vaults are backed up to the secure cloud bucket via `backup.js` (need to update inclusion rules).

## 6. Verification Plan
- **Test 1**: API Create Vault -> Check folder explicitly.
- **Test 2**: Upload File -> Check `files/` folder.
- **Test 3**: Agent "Context Switch" -> Verify System Prompt contains `index.md`.
