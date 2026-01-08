# Technical Decisions & Constraints

> [!IMPORTANT]
> **NOTE TO AI AGENTS**: Before designing or implementing new features (especially related to Audio, Search, or Real-time APIs), **YOU MUST READ THIS DOCUMENT**. It contains critical constraints and patterns discovered through hard-fought debugging. Ignore them at your own peril.

This document records key technical decisions, discovered constraints, and implementation patterns to avoid regression.

## 1. Audio Generation (Gemini API)
### Constraint
The `generateContent` method with `responseModalities: ['AUDIO']` **DOES NOT** support the `responseMimeType` configuration parameter for audio formats (e.g., setting `responseMimeType: 'audio/mp3'` throws `INVALID_ARGUMENT`).

### Solution (WAV Wrapping)
- **Mechanism**: The API returns raw audio data (PCM/WAV-like) in the `inlineData`. 
- **Implementation**: We must explicitly wrap this raw buffer with a valid **WAV Header (RIFF)** on the server-side before treating it as a playable file.
- **Standards**: 
    - Sample Rate: 24kHz (default from Gemini)
    - Channels: 1 (Mono)
    - Depth: 16-bit
- **Reference**: `apps/agent/src/utils/audio.js` -> `createWavHeader`.

---

## 2. Runtime Settings & Configuration
### Problem
Tools (like `MediaExecutor`) and core agent logic often need access to dynamic user settings (e.g., `voice`, `search_strategy`) synchronously or with minimal latency. Fetching from the SQLite DB (`agent_settings`) on every single tool execution is inefficient and can lead to race conditions during startup if the DB isn't hot.

### Solution (Read-Through Cache)
1.  **Boot Loading**: The `Agent` class has a `loadSettings()` method that loads all rows from `agent_settings` into an in-memory `this.settings` object during `start()`.
2.  **Write Updates**: The `POST /settings` endpoint writes to the DB **AND** immediately updates the in-memory `agent.settings` object.
3.  **Access Pattern**: Executors should access `this.services.agent.settings[key]` first. Fallback to DB is only necessary if there's suspicion of cache invalidation (rare).

---

## 3. Tool Execution Context
### Pattern
The `ToolExecutor` is initialized with access to the `Agent` instance (`this`). This allows tools to access high-level agent state (like the settings cache mentioned above) via `this.services.agent`.

```javascript
// apps/agent/src/agent.js
this.toolExecutor = new ToolExecutor({
    // ...
    agent: this // Inject self
});
```

---

## 4. Search Strategy (Hybrid)
### Constraint
The Gemini API provides two ways to search:
1.  **Google Grounding (`googleSearch`)**: Native, fast, provides sources/citations, but **cannot be combined** with other functional tools (e.g., `replyWithAudio`) in the same turn. Attempting to mix them causes API errors.
2.  **Tool Polyfill**: A custom function declaration (e.g., `google_search` via MCP). This is slower but is treated as a standard tool, allowing it to be mixed with other tools.

### Solution (Context-Aware Hybrid Mode)
We implement a **Hybrid Strategy** in `apps/agent/src/agent.js`:
- **Text-Only Context**: Defaults to **Native Grounding** for better quality and citations.
- **Audio/Voice Context**: Defaults to **Standard Polyfill** to allow mixing with `replyWithAudio` (TTS), ensuring the agent can "speak" the search results.
- **Configuration**: Controlled via `config:search_strategy` key in `agent_settings`.

---

## 5. Live API Integration (WebSockets)
### Constraints
- **Strict Schema**: The Gemini Live API (WebSocket) is extremely strict about tool schemas. It rejects schemas with keys like `additionalProperties` or certain `$ref` structures that valid JSON Schemas might allow.
- **Voice Configuration**: The voice preference (e.g., `Puck`, `Kore`) **MUST** be sent in the initial `setup` message handshake. It cannot be changed comfortably mid-session.
- **Audio Output**: The Live API tends to return raw PCM (often 24kHz) in chunks.

### Implementation Pattern (`apps/web/src/app/live/page.js`)
1.  **Schema Cleaning**: We use a recursive `cleanSchema` function to strip unauthorized keys before sending tools to the API.
2.  **Handshake**: We fetch the user's `voice` setting **before** connecting and inject it into the `prebuilt_voice_config` of the `setup` payload.
3.  **Client-Side playback**: We handle the PCM stream using an `AudioWorklet` to ensure low latency.

---

## 6. Multi-Brain Architecture (WhatsApp)
### Decision
To support both a "User" (me acting via WhatsApp) and an "Assistant" (the bot replying), we treat them as distinct **Sessions**:
- **Assistant Session**: The bot's connection. It listens to user messages and replies.
- **User Session**: The user's own WhatsApp connection (linked device). It creates an "interface" for the agent to act on the user's behalf (e.g., "Send a message to Mom").

### Storage
- We use the Multi-Device API (`@whiskeysockets/baileys`).
- Credentials are stored in `data/baileys_auth_info` (Assistant) and `data/baileys_auth_info_user` (User).
- The `InterfacesService` manages these as distinct concurrent connections.
