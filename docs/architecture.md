# Deedee Architecture

## System Overview
Deedee is a personal AI agent designed to run on a Raspberry Pi. It uses a microservices architecture orchestrated by Docker Compose. The system is designed for security, extensibility, and self-improvement.

## Components

### 1. Core Agent (`apps/agent`)
- **Runtime**: Node.js
- **Framework**: LangChain or Google GenAI SDK
- **Role**: The Brain.
- **Capabilities**:
    - **Multimodal Routing:** Intelligently routes requests to `GEMINI FLASH` (Tools/Speed) or `GEMINI PRO` (Reasoning/Coding).
    - **Native TTS:** Generates high-quality speech using Gemini 2.5 (`LINEAR16`, `WAV`) with multilingual support.
    - **Tool Executor**: Decoupled tool handling using `ToolExecutor` class. Delegates to Local, Scheduler, GSuite, and MCP tools.
    - **Optimization**:
        - **Adaptive Context**: Dynamically sizing history (10 vs 50 msgs) based on model complexity.
        - **Image Bypass**: Direct execution of image generation, skipping the reasoning model for speed.
        - **Parallel Tools**: Executes multiple tool calls concurrently for faster turnaround.
    - **Safety Guard**: Verifies sensitive tool usage (e.g., shell commands) and blocks ambiguous dictation commands (`iphone` source).
    - **Google Search Split**: To bypass model limitations (Gemini 3 Preview vs Tools), general search queries are executed via a side-channel call to a Flash/Pro model (`WORKER_GOOGLE_SEARCH`) instead of the main agent model.
    - **MCP Manager**: Orchestrates tools via the Model Context Protocol.

### 2. Supervisor (`apps/supervisor`)
- **Role**: The Immune System.
- **Capabilities**:
    - **Privileged Access**: Has full filesystem/git access.
    - **Self-Healing**: Monitors the Agent. If tests fail or the agent crashes, it performs a "Hard Reset" (re-clones code).
    - **Updater**: Applies code changes requested by the Agent (Self-Improvement loop).

### 3. API Gateway (`apps/api`)
- **Type**: Express Service (Port 3001)
- **Routes**:
    - `POST /v1/chat`: Synchronous chat interface.
    - `GET /v1/briefing`: Generates a spoken morning briefing (text).
    - `GET /v1/city-image`: Generates a weather-aware city wallpaper (PNG).
    - `GET /v1/journal`, `/v1/tasks`, `/v1/facts`: Dashboard data endpoints.
- **Auth**: Bearer Token (`DEEDEE_API_TOKEN`). All routes protected.
- **Flow**: Client -> API -> Agent (Waits for full processing) -> API -> Client JSON Response.

### 4. Interfaces (`apps/interfaces`)
- **Role**: The Ears and Mouth.
- **Port**: `5000`
- **Supported Channels**:
    - **Socket.io**: Real-time event-based communication for Web Interface.
    - **Telegram**: Long-Polling Bot. Supports Global Stop (`/stop`) and Audio Messages.
    - **Internal Webhook**: Legacy ingress for async messages.

### 5. Web Interface (`apps/web`)
- **Type**: Next.js 14 App (Port 3002)
- **Role**: Visual Dashboard & detailed Chat.
- **Features**: Real-time Chat, Markdown Journal, Memory Bank, Task Scheduler.
- **Auth**:
    - **User**: Relies on Reverse Proxy (Authelia/Authentik).
    - **Service**: Injected `DEEDEE_API_TOKEN` for secure API communication (Server Actions).

### 6. MCP Servers (`packages/mcp-servers`)
- **Role**: Tool Providers.
- **Servers**:
    - **Local**: File system, time, shell execution.
    - **GSuite**: Google Calendar (OAuth).
    - **Plex**: Media library search and playback status (Python-based).
    - **Plex**: Media library search and playback status (Python-based).
    - **Home Assistant**: Control smart home devices (`ha-mcp`). Active.

### 7. Logs Service (`/v1/logs`)
- **Role**: Centralized Log Streaming.
- **Mechanism**: Reads Docker logs from the host via socket proxy.
- **Features**: 
    - Server-Sent Events (SSE) stream to Web UI.
    - Historical log fetching (since 10m, 1h).
    - Auto-reconnect resilience.

## Data Perspectives

### Security Model
1.  **Network Isolation**: No container relies on public ingress. All inter-service communication is internal Docker networking.
2.  **Authentication**:
    -   API: Bearer Token.
    -   Telegram: `ALLOWED_TELEGRAM_IDS` allowlist.
3.  **Safety Mechanisms**:
    -   **Global Stop**: `/stop` command halts all active execution loops instantly.
    -   **Dictation Safeguard**: Heuristic checks for ambiguous voice input from iOS.
    -   **Sensitive Tool Guard**: "YOLO" mode but with confirmation requirements for high-risk actions if unsure (Refining).

### Self-Improvement Loop
1.  **Request**: "Add PDF support."
2.  **Planning**: Agent designs change.
3.  **Execution**: Agent uses `write_to_file` / `run_command` via Supervisor.
4.  **Verification**: Supervisor runs `npm test`.
5.  **Deployment**: Supervisor commits & pushes -> GitHub Actions -> Balena Cloud -> Device Update.

## Persistence
-   **Agent**: SQLite Database (`agent.db`) for Chat History (hydrated on every turn).
-   **Filesystem**: Source code is persistent via volume mount.
