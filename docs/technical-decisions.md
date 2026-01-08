# Technical Decisions & Constraints

This document records key technical decisions, discovered constraints, and implementation patterns to avoid regression.

## 1. Boolean & Audio Generation (Gemini API)
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
