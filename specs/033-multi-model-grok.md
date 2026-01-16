# 033 - Multi-Model Support (Grok)

## Context
The user wants to select different AI models in the Web Chat interface, specifically adding support for **Grok (xAI)** while keeping the default "Auto" (Gemini Router) behavior. This is strictly for the web client.

## Goals
1.  **UI**: Add a Model Selector (Auto, Grok, etc.) to the Chat Interface.
2.  **Settings**: Add a UI to manage API Keys (specifically `XAI_API_KEY`) so the user can enable Grok.
3.  **Backend**: Integrate generic OpenAI-compatible provider logic (for xAI) into the Agent.
4.  **Compatibility**: Ensure the frontend continues to receive data in the existing Google Gemini format (Parts, Roles) to avoid UI breakage.

## Architecture

### 1. Frontend (Web)
-   **Chat Page**: Add a Combobox in the header next to the Vault Selector.
    -   Options: `Auto (Default)`, `Grok Beta`, `Grok Vision`.
    -   Selection persists in `localStorage` or Session state (per chat).
    -   Sends `metadata: { model: 'grok-beta' }` with the message.
-   **Settings Page**: Add a new "Models" tab.
    -   List supported providers (xAI).
    -   Input field for API Key.
    -   Save via `POST /internal/settings` (persists to `agent_settings` DB table).

### 2. Backend (Agent)
-   **Configuration**: Load `xai_api_key` from `agent_settings` during `loadSettings()`.
-   **Client Initialization**: Initialize `OpenAI` client (pointing to `https://api.x.ai/v1`) if key is present.
-   **Process Message Loop**:
    -   Detect `metadata.model`.
    -   If `metadata.model` starts with `grok`:
        -   **Bypass Router**: Do not call `router.route()`.
        -   **Context**: Fetch history using `db.getHistoryForChat`.
        -   **Adapter**: Convert Gemini History (`parts`, `role: model`) to OpenAI Messages (`content`, `role: assistant`).
        -   **Generation**: Call `xai.chat.completions.create` (stream).
        -   **Tooling**: Convert internal Tool Definitions to OpenAI Tool Schema.
        -   **Output**: Convert OpenAI Stream chunks back to Gemini format (`{ candidates: [ { content: { parts: [...] } } ] }`) so `processMessage` downstream logic (validation, DB save) works unchanged.

## Data Structures

### Settings (DB: `agent_settings`)
```json
{
  "key": "provider:xai",
  "value": {
    "apiKey": "xai-...",
    "models": ["grok-beta", "grok-2"]
  }
}
```

### Metadata
```json
{
  "model": "grok-beta",
  "vaultId": "finance" // Can coexist
}
```

## Risks
-   **Tool Incompatibility**: OpenAI tools format differs from Gemini. We need a robust mapper.
-   **Token Counting**: Gemini counts tokens differently. We might need rough estimation for Grok or use usage data from response.
-   **Multimedia**: Grok Vision supports images. We need to map `inlineData` (Base64) to OpenAI Image URL / Base64 format.

## Out of Scope
-   Voice/Audio for Grok (Grok is text/vision only).
-   Changing the default "Auto" behavior for WhatsApp/Telegram (Web only feature).
