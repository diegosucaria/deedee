# Deedee Architecture

## System Overview
Deedee is a personal AI agent designed to run on a Raspberry Pi. It uses a microservices architecture orchestrated by Docker Compose. The system is designed for security, extensibility, and self-improvement.

## Components

### 1. Core Agent (`apps/agent`)
- **Runtime**: Node.js
- **Framework**: LangChain or Google GenAI SDK
- **Role**: The Brain.
- **Capabilities**:
    - **Multimodal Routing:** Intelligently routes requests to `GEMINI FLASH` (Tools/Speed), `GEMINI LITE` (Ultra-cheap simple tasks), or `GEMINI PRO` (Reasoning/Coding). Supports `forceModel` bypass for scheduled jobs to skip the router call entirely.
    - **Native TTS:** Generates high-quality speech using Gemini 2.5 (`LINEAR16`, `WAV`) with multilingual support.
    - **Sticky Routing:** Maintains model context (PRO vs FLASH) for multi-turn conversations by tracking `lastModel` metadata, ensuring complex reasoning tasks aren't interrupted by short follow-ups.
    - **Tool Executor**: Decoupled tool handling using a modular `ToolExecutor` facade. Delegates to domain-specific executors:
        - `FileSystemExecutor`, `MemoryExecutor`, `SchedulerExecutor`, `SmartHomeExecutor`, `GSuiteExecutor`, `MediaExecutor`, `ProductivityExecutor`, `SubAgentExecutor`, `DJExecutor`, `WardrobeExecutor`.
    - **Tool Auto-Scoping**: Each tool definition includes a `category` field (e.g., `memory`, `slack`, `calendar_email`). A `ToolScoper` service uses a cheap LLM call to analyze scheduled job prompts on save, determining which tool categories are needed. At runtime, only relevant tools are included in the request, reducing input token costs. MCP tools are classified by namespace pattern.
    - **Multi-Agent**: Spawns isolated child agents (`SubAgentService`) for parallel tasks. Max 3 concurrent, 10-min timeout, depth=1.
    - **Notification Service**: Persists system alerts (tool truncation, errors) to SQLite and broadcasts via Socket.io for real-time UI updates.
    - **Optimization**:
        - **Smart Context**: Intelligent token management with auto-summarization (`gemini-2.5-flash`) and long-term memory via a `summaries` table.
        - **Cost Tracking**: Real-time cost estimation using exact model matching (e.g., `gemini-2.5-flash`), tiered pricing (<=128k/200k vs >), and fallback logging. Tracks actual tokens saved via summarization.
        - **Adaptive Context**: Dynamically sizing history (10 vs 50 msgs) based on model complexity.
        - **Image Bypass**: Direct execution of image generation, skipping the reasoning model for speed.
        - **Parallel Tools**: Executes multiple tool calls concurrently for faster turnaround.
    - **Session Management**:
        - **Persistent Threads**: Manages multiple `chat_sessions` with auto-titling.
        - **Referential Integrity**: Ensures every message belongs to a valid session (`ensureSession`).
    - **Safety Guard**: Verifies sensitive tool usage (e.g., shell commands) and blocks ambiguous dictation commands (`iphone` source).
    - **Hybrid Search Strategy**:
        - **Native Grounding**: Uses Gemini's built-in Google Search grounding for text-only queries (Speed/Accuracy).
        - **Standard Tool**: Uses a polyfill `googleSearch` tool for Auto-Audio and multimodal contexts where native grounding is unsupported.
    - **Google Search Split**: To bypass model limitations (Gemini 3 Preview vs Tools), general search queries are executed via a side-channel call to a Flash/Pro model (`WORKER_GOOGLE_SEARCH`) instead of the main agent model.
    -   **Settings Manager**:
        -   **Unified Config**: Centralized key-value store (`agent_settings` table) for all dynamic behaviors (Voice, Search Strategy, etc.).
        -   **Read-Through Cache**: On-boot hydration into memory for synchronous, high-performance tool access.
    - **MCP Manager**: Orchestrates tools via the Model Context Protocol.
    - **Backup Manager**: Automates nightly zipping and uploading of `/app/data` to Google Cloud Storage with retention policy.
    - **Vault Manager**:
        - **Filesystem Backed**: Stores vaults as directories in `/app/data/vaults/{topic}`.
        - **Sanitization**: Ensures safe filenames and prevents traversal.
        - **Auto-Context**: Injects active vault index and file lists into the prompt when a topic is selected.
    - **Local RAG Service**:
        - **Vector Store**: Uses `better-sqlite3` (`rag.db`) to store document chunks and embeddings.
        - **Vault Integration**: Scoped to "Life Vaults". Files added to vaults are auto-indexed (`vault_id` aware).
        - **Embeddings**: Uses Gemini Embeddings via `ConfigService`.
        - **Search**: Semantic search via `searchDocuments` tool + `RagExecutor`, filtered by active vault context.

### 2. Supervisor (`apps/supervisor`)
- **Role**: The Immune System.
- **Capabilities**:
    - **Privileged Access**: Has full filesystem/git access.
    - **Self-Healing**: Monitors the Agent. If tests fail or the agent crashes, it performs a "Hard Reset" (re-clones code).
    - **Update Manager**: Applies code changes requested by the Agent (Self-Improvement loop).
    - **Health Monitor**:
        - **Proactive Polling**: Checks status of Agent (DB, Config), API (Reachability), and Interfaces every 30s.
        - **Aggregated Report**: Exposes `/health` endpoint with full system status for dashboards.

### 3. API Gateway (`apps/api`)
- **Type**: Express Service (Port 3001)
- **Routes**:
    - `GET /health`: Public endpoint checking/proxying system health.
    - `POST /v1/chat`: Synchronous chat interface.
    - `GET /v1/sessions`: Chat session management (CRUD).
    - `GET /v1/history`: Retrieve full chat history & summaries.
    - `GET /v1/briefing`: Generates a spoken morning briefing (text).
    - `GET /v1/city-image`: Generates a weather-aware city wallpaper (PNG).
    - `GET /v1/journal`, `/v1/tasks`, `/v1/facts`: Dashboard data endpoints.
    - `POST /v1/cron-helper`: AI-powered natural language to cron expression converter (uses LITE model).
    - `GET /v1/goals`: Manage agent goals (CRUD).
    - `GET /v1/config`: Read/Write system configuration & env.
    - `POST /v1/settings`: Update runtime settings (updates DB + Cache).
    - `GET /v1/backups`: Manage backup archives.
    - `GET /v1/logs/:container`: Stream real-time logs (SSE-like).
    - `POST /v1/whatsapp`: Control WhatsApp sessions (connect/disconnect).
    - `GET /v1/whatsapp/contacts`: Search synced WhatsApp contacts.
    - `GET/POST /v1/gsuite/*`: Google Workspace OAuth and Account Management.
    - `POST /v1/live/token`: Proxy for Gemini Live ephemeral tokens.
    - `POST /v1/live/tools/execute`: Proxy for Gemini Live client-side tool execution.
    - `GET /v1/vaults`: List and manage Life Vaults.
    - `GET/POST /v1/browser-secrets`: Securely manage browser automation credentials.
    - `GET/POST /v1/vaults/:id/files`: Secure file upload to vaults. [Proxy -> Agent]
    - `GET /v1/vaults/:id/files/:filename`: Secure file download. [Proxy -> Agent]
    - `GET /v1/subagents?page=1&limit=50`: List sub-agent tasks (paginated, max limit 100).
    - `GET /v1/subagents/:id`: Get sub-agent task detail.
    - `POST /v1/subagents/cleanup`: Cleanup completed sub-agent sessions.
    - `GET /v1/notifications`: List system notifications (filterable).
    - `GET /v1/notifications/count`: Get unread notification count.
    - `POST /v1/notifications/:id/read`: Mark notification as read.
    - `POST /v1/notifications/read-all`: Mark all notifications as read.
    - `POST /v1/notifications/:id/dismiss`: Dismiss a notification.
    - `POST /v1/notifications/dismiss-all`: Dismiss all notifications.
    - `DELETE /v1/notifications/:id`: Delete a notification.
    - `/v1/dj/*`: DJ crate management (vinyls, crates). Agent-backed. See [docs/dj-assistant.md](dj-assistant.md).
    - `/v1/wardrobe/*`: Wardrobe service (garments, outfits, trips, shopping list, profile). Agent-backed. See [docs/wardrobe.md](wardrobe.md).
- **Socket.io Proxy**: `/socket.io` path is proxied to `interfaces:5000` via `http-proxy-middleware` with full WebSocket upgrade support. Traefik's `google-auth` middleware gates the path on the reverse proxy and stamps `X-Forwarded-User` on authenticated requests. The API gateway requires that header (defense-in-depth) and injects `DEEDEE_API_TOKEN` into the upstream URL so Interfaces accepts the connection. The browser never holds the API token — auth is the `_forward_auth` cookie. Clients use `transports: ['websocket']` to keep traffic to a single WS upgrade per connection (no polling, no forward-auth cookie spam).
- **Auth**: Bearer Token (`DEEDEE_API_TOKEN`) for `/v1/*`. `/socket.io` requires `X-Forwarded-User` (set by Traefik forward-auth). `/health` is public.
- **Security**: All route parameters are encoded with `encodeURIComponent()` to prevent injection via crafted job names or IDs.
- **Flow**: Client -> API -> Agent (Waits for full processing) -> API -> Client JSON Response.


### 4. Interfaces (`apps/interfaces`)
- **Role**: The Ears and Mouth.
- **Port**: `5000`
- **Supported Channels**:
    - **Socket.io**: Real-time event-based communication for Web Interface. Browser clients connect via the API gateway (`/socket.io` proxy) which handles WebSocket upgrades.
        - **Auth**: Two paths, both backed by `DEEDEE_API_TOKEN`. Internal services (agent, browser screencast tools) connect with the token in `handshake.auth.token` and are marked `isTrusted` (only these can emit `browser:frame`). Browser clients receive the token from the API gateway as a query param after Traefik's forward-auth accepts the user — they can connect but are NOT trusted.
        - Emits: `agent:message` (Stream), `agent:thinking` (Status), `session:update` (Auto-Title), `subagent:update` (Sub-agent status change), `notification:new` (System notifications).
    - **Telegram**: Long-Polling Bot. Supports Global Stop (`/stop`) and Audio Messages.
    - **WhatsApp**:
        - **Dual Session Architecture**: Runs two concurrent Baileys sockets:
            1.  **Assistant Session**: The bot account (Listens & Replies). Uses `messages_assistant.db`.
            2.  **User Session**: The linked user account (Acts on behalf of User). Uses `messages_user.db`.
        - **Data Handling**: WhatsApp messages are stored in their own localized SQLite databases (`messages_*.db`) rather than directly in `agent.db` for performance and sync stability. The Agent merges these datasets during tasks like memory consolidation.
        - **Features**: Syncs contacts, sends text/audio/images, supports "Contact Search".
    - **Internal Webhook**: Legacy ingress for async messages.

### 5. Web Interface (`apps/web`)
- **Type**: Next.js 14 App (Port 3002)
- **Role**: Visual Dashboard & detailed Chat.
- **Features**: Real-time Chat with Sessions, Markdown Journal, Memory Bank, Task Scheduler, System Notifications (bell icon + management page).
- **Runtime Config**: `SOCKET_URL` env var is read server-side by `layout.js` and injected into the client as `window.__DEEDEE_CONFIG__.socketUrl`. This is required because Next.js `NEXT_PUBLIC_*` vars are baked at build time, but Balena/Docker sets env vars at container start.
- **Auth**:
    - **User**: Relies on Reverse Proxy (Authelia/Authentik).
    - **Service**: Injected `DEEDEE_API_TOKEN` for secure API communication (Server Actions).

### 6. MCP Servers (`packages/mcp-servers`)
- **Role**: Tool Providers.
- **MCP Servers**: Standardized tools.
    - **Browser**: Agentic web browsing via Playwright using ARIA Snapshot + Ref-Based Interactions. Supports Real-Time CDP Streaming (JPEG) via Socket Relay to Interfaces.
    - **Memory**: Knowledge graph.
    - **GSuite**: Google Calendar and Email (OAuth).
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
    -   API: Bearer Token (`DEEDEE_API_TOKEN`).
    -   Socket.io: Traefik forward-auth (`X-Forwarded-User`) for browser clients gated at the API gateway; the gateway injects `DEEDEE_API_TOKEN` into the upstream handshake so Interfaces accepts the connection. Internal services authenticate directly with `DEEDEE_API_TOKEN` in `handshake.auth.token`.
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
