# Spec: Gemini Live API Integration

## Goal
Enable real-time, low-latency voice interaction with Deedee using Google's Gemini Live API via WebSockets.

## Architecture
**Client-to-Server** connection to Google for maximum speed, mediated by the backend for authentication (Ephemeral Tokens).

## Backend (`apps/interfaces`)

### `POST /live/token`
*   **Auth**: Protected by `DEEDEE_API_TOKEN`.
*   **Action**: Calls Google API to generate an ephemeral service access token.
    *   **Scope**: `https://www.googleapis.com/auth/generative-language.retriever.readonly`, `https://www.googleapis.com/auth/cloud-platform` (Check exact scopes from docs).
*   **Response**: `{ token: "..." }`
*   **Logic**: Use `google-auth-library` or direct HTTP post to `https://generativelanguage.googleapis.com/v1beta/openai/ephemeralTokens` (or equivalent endpoint).

## Frontend (`apps/web`)

### New Page: `/live`
*   **UI**:
    *   Full-screen immersive overlay.
    *   **Visualizer**: Audio waveform or abstract orb animation reacting to volume/VAD.
    *   **Controls**: Mute Mic, Interrupt (Stop Audio), Disconnect.
*   **Logic**:
    1.  Fetch Token from `/live/token`.
    2.  Open WebSocket to `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`.
    3.  **Handshake**: Send `setup` message with model config (`gemini-2.0-flash-exp` or similar) and `tools` definition.
    4.  **Audio Loop**:
        *   Capture Microphone -> Resample to 16kHz PCM -> Base64 -> Send `realtime_input`.
        *   Receive `server_content` -> Decode Base64 PCM -> Queue -> Play via Web Audio API.
    5.  **Tool Handling**:
        *   If `tool_call` received -> Execute client-side or proxy to agent -> Send `tool_response`.

## Agent Integration
*   The generic `tools-definition.js` should be importable by the frontend (shared package?) OR the frontend should fetch the tool definitions from the Agent API on startup.
*   *For now*: Hardcode critical tools or fetch from `GET /api/tools` (if exists, otherwise create).

## Requirements
*   **Browser**: Chrome/Edge/Safari (recent).
*   **Permissions**: Microphone access.
