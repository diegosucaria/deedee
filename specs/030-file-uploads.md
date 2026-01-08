# File Uploads & Smart Vault Integration

## Goal
Allow users to upload files (PDF, Docs, etc.) to the chat. The system should intelligently organize these files into the appropriate Vault (e.g., Health, Finance) and generate smart titles based on content.

## User Stories
1.  **Upload**: User clicks a "Paperclip" icon to upload a file (e.g., `blood_test_results.pdf`).
2.  **Smart Detection**:
    -   If it's a new chat, the system analyzes the file.
    -   **Title Generation**: Updates the chat title to something meaningful (e.g., "Blood Test Results - Jan 2026").
    -   **Vault Routing**: Detects if it belongs to a semantic Vault (e.g., "Health").
    -   **Action**: Automatically moves the file to the detected Vault and switches the chat context to that Vault.
3.  **Fallback**: If no specific vault matches, it stays in a "General" context (file stored in `data/uploads/{chatId}`).
4.  **Metadata**: System tracks upload date and original filename.

## Architecture

### 1. Storage Strategy
-   **Temporary / Generic**: `data/uploads/{chatId}/`
    -   Files live here by default until assigned to a vault.
-   **Vaults**: `data/vaults/{topic}/files/`
    -   Files are moved here when a vault is assigned.

### 2. API Endpoints
-   `POST /v1/chat/:id/files`
    -   Uploads a file to the generic/chat storage.
    -   Returns: `{ path, filename, mimetype, size }`.

### 3. Agent Logic (Smart Detection)
-   Trigger: When a file is uploaded in a **new session** (msgCount < 2) or explicitly requested.
-   Task:
    1.  Read file content (text/OCR).
    2.  Prompt Gemini:
        ```text
        Analyze this document.
        1. Generate a short, descriptive title for this chat (max 6 words).
        2. Determine if this belongs to one of the following vaults: [Health, Finance]. If unsure, output "None".
        3. Extract key metadata (Date, Type).
        Return JSON.
        ```
    3.  **Execute Decision**:
        -   Update Chat Title.
        -   If Vault != None: Move File -> `addToVault` -> Set Session Context.

### 4. Frontend Changes
-   **UI**: Add `Paperclip` icon next to Mic/Image.
-   **Action**: Handle file selection -> Upload to API -> Send message with connection to file.

## Technical Details
-   **Dependencies**: Requires `pdf-parse` (or just use Gemini multimodal capabilities if file size permits).
    -   *Decision*: Use Gemini Multimodal (Base64 for < 10MB, File API for > 10MB if feasible, else specific parsers).
    -   *Simplification*: Start with Gemini Inline Data (Base64) for analysis. Add `pdf-parse` only if cost/latency is high.
-   **Security**: Validate file types (limit to safe extensions).
