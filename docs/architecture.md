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
    - **Multi-Agent**: Spawns isolated child agents (`SubAgentService`) for parallel tasks. Max 10 concurrent, 6-min timeout (10 max), depth up to 3. Model class per task: `LITE` for `lightweight` scans (`SUBAGENT_LIGHTWEIGHT_MODEL`), `FLASH` by default, `PRO` on request. Each run gets `metadata.maxToolLoops` (20, or 50 for browser tools or PRO; `SUBAGENT_MAX_TOOL_LOOPS`, `SUBAGENT_MAX_TOOL_LOOPS_BROWSER`) and no thought parts. A result over `SUBAGENT_RESULT_CAP` (4,000 chars) comes back compressed by `LITE`; the full text sits in `subagents.result_full` and `getAgentResult(taskId, full: true)` returns it.
    - **System jobs** (`scheduler.js` `SYSTEM_JOBS`): the jobs that run an agent turn (`proactive_thought`, `wardrobe_pretrip_check`, `wardrobe_morning_outfit`) carry a `model` and an `allowedTools` list, passed as `forceModel`/`allowedTools` like user jobs. A persisted row with its own `model` or `allowedTools` wins and survives the boot rewrite; the defaults are stored under `payload.scope`. `SYSTEM_JOBS_SCOPED=0` sends neither. `nightly_consolidation`, `nightly_backup`, `nightly_rag_scan`, `nightly_memory_pruning`, `nightly_dream` and the partner greetings call their service directly, with no agent turn.
    - **User jobs**: `Scheduler._buildAgentInstructionCallback()` builds every job that runs an agent turn: the Tasks form, the `scheduleJob` and `scheduleTask` tools, and `loadJobs` at boot. Before 2026-09-28 a job made in a chat ran inside that chat and sent every reply straight out, the `[SILENT]` tag and the "Thinking..." lines too.
        - A run writes to its own chat, `scheduled_<name>_<ms>`, with the scheduler source, the job's tool list and a note: `JOB_RUN_NOTE` for a repeating job, `TASK_RUN_NOTE` for a one-time task. Each run of a repeating job adds `getJobState` and `saveJobState` to its list, as its note tells it to use them. The run carries a record, `metadata.jobRun` (`name`, `runId`, `madeByJob`, `markOwner`), and so do its sub-agents and the built-in jobs' runs.
        - The result is the run's last reply that is not a progress line (`isProgress`). A line about the run (`isStatus`: `'stopped'` for the owner's /stop or a cancel, `'refused'` for the breaker, `'failed'` for the loop limit, repeated calls or no answer) voids any answer, as the model's last words still go out once the loop stops. A reply that starts with `[SILENT]` sends nothing, and neither does the agent's own error reply (`isError`). A result that merely starts with ⚠️ still goes out. "✅ Action X completed." (`isImplicit`) is not news for a repeating job; a one-time task sends it as its confirmation. A picture or a voice note from the run goes where the result goes, as it comes.
        - The chat the job was made in (`targetChatId`, `targetSource`) decides where the result goes. The owner's own WhatsApp (assistant) or Telegram chat gets it there, and a Telegram chat keeps it in its history. Anything else goes to the owner channel: a web chat, a contact, a group. A web chat still shows the job's approval cards (`metadata.jobOrigin`), and a one-time task made there confirms on the owner channel. A job saved long ago with a passive chat (`whatsapp:user`, `slack`) does nothing: the agent only stores those chats' messages.
        - The taint mark: a run is marked (`jobRun.markOwner`) when its job answers in his own chat or a tainted run made the job. What a marked run or its sub-agents send him after reading untrusted content carries `metadata.jobTaint`: its result, a `sendMessage` to him and an `askUser` question. So does a reminder a marked run set after reading untrusted content (`markOnDelivery`); one he set in his own chat, or one a built-in or form job set, does not. The WhatsApp thread mirror keeps the mark on the stored row, where it holds back his next word, as the run's tool results did when the job ran inside his chat (see `docs/security.md`, Approvals). A job made in the web chat or the Tasks form carries no mark.
        - A one-time task that ends with no answer (the agent's error reply, any line about the run, or no reply at all) is not run again: its first try may have sent a message or asked a card. The owner hears once, in fixed words, why (an error, a stop, refused actions, no answer), and Job History logs a failure. A run that paused on an approval card stays quiet: the card asks him. A run approved later keeps the run record (`origin_meta.jobRun`). Run now on a one-time task cancels its set time, so it runs once. A thrown error is retried three times, unless the task was deleted, changed or paused while it ran. A repeating job that fails runs again at its next time; its retry used to take its name as a one-off, which is deleted once it has run.
        - `scheduleJob` with the name of an existing repeating job changes it in place. The job keeps its chat, saved state, end date when none is given, model, pause and taint, and its tool list while the task is unchanged (compared without line ends). The model used to cancel a job and make it again, so the new job reported to the chat the change came from. A change that changes nothing saves nothing (a missing end date and `null` are the same). The form's Weekdays and Daytime marks stay only while the times do. A schedule the scheduler refuses leaves the old job as it was. A one-time task is not changed this way: it is cancelled and made again with `scheduleTask`. `this.jobs` has no prototype, so a job named `constructor` is an ordinary job.
        - Limits on what the model makes. A new job's name is 1 to 80 letters, digits, spaces and `_ . : -`, or a 40-character slug when the run read untrusted content; an end date is an ISO 8601 date. A schedule is one of node-schedule's aliases (`@hourly` to `@yearly`), or five cron fields (six with a fixed seconds value) whose minutes, hours and days are numbers, running at most every 15 minutes, unless the job keeps its times and its task. A job's run, its sub-agents included, makes and changes no repeating jobs, makes at most two one-time tasks (a slot is taken before anything awaits, so calls side by side in one turn count too), and cancels only its own job or a task a job made. A task a job run made (`madeByJob`) makes none. `cancelJob` refuses a built-in job. `listJobs` leaves out the task of a job a tainted run made (`task: null, taskHidden: true`); `scheduleJob` with its name and no task keeps the task.
        - Tool lists: the tools and the form pick one when they save a job (`Scheduler.scopeJobTools`, `ToolScoper`, 20 s at most). A job made in a chat before 2026-09-28 has none; it gets one on its first run and keeps it. `ToolScoper` hands out Home Assistant's own tools with the device aliases.
        - One run of a user job at a time: a tick that comes while its last run still goes is skipped. A one-off's retry survives the clean-up of the run that failed.
        - `JOB_OWN_CHAT=0` runs a job made in a chat inside that chat again, with its replies held for the end of the run. There the chat's router picks the tools, and the job's own list is not applied.
    - **Job History** (Tasks page): each row links to the run's own messages, every tool call and result. A run writes to `scheduled_<name>_<ms>` or `system_<name>_<ms>`, with the ms taken as it began, and its log row is written as it ends, so `AgentDB.getJobRunHistory()` looks for that chat between (row time - `duration_ms`) and the row time. When runs of one job overlap, a run's own chat is the first one in its window. A run that wrote into one of your chats (`targetChatId`: runs before 2026-09-28, or with `JOB_OWN_CHAT=0`) links to that chat between the run's start and its end. A job that runs no agent turn has no link. The Cost column is priced from the same chat plus every sub-agent under it, however deep (`getJobRunCost()`); for a target chat, only what that chat spent inside the run. It used to count forward from the row's time and so missed almost the whole run. `idx_token_usage_chat` and `idx_subagents_parent` keep a page of rows cheap. A reminder the scheduler delivers after a restart carries a **Late** badge: the owner's message gets a `(late)` prefix and the job log output gets `{"late":true,...}` (`_deliverLateReminder`, read back by `isLateRun()` in `apps/web/src/lib/job-history.js`).
    - **Message History** (`/system/history`): each row shows its stored `content` and a **parts** toggle. The toggle lists every part: text, a thought, a tool call with its name and arguments, a tool result, or an inline blob. Image and audio bytes print as `<image>` and a long body opens with a first screenful and a "show all" (`apps/web/src/lib/message-parts.js`). The Summaries view has a **Clear Summaries** button, which asks first and then calls `POST /internal/summaries/clear`.
    - **Models** (`/system/models`): read-only table of the model roles, their ids, their prices and the last smoke run. See [models.md](models.md).
    - **Notification Service**: Persists system alerts (tool truncation, errors) to SQLite and broadcasts via Socket.io for real-time UI updates.
    - **Optimization**:
        - **Smart Context**: Intelligent token management with auto-summarization (the `FLASH` role, see [models.md](models.md)) and long-term memory via a `summaries` table.
        - **Cost Tracking**: Real-time cost estimation using exact model matching (e.g., `gemini-3.6-flash`), tiered pricing (<=128k/200k vs >), and fallback logging. Tracks actual tokens saved via summarization.
        - **Adaptive Context**: Dynamically sizing history (10 vs 50 msgs) based on model complexity.
        - **Image Bypass**: Direct execution of image generation, skipping the reasoning model for speed.
        - **Parallel Tools**: Executes multiple tool calls concurrently for faster turnaround.
    - **Session Management**:
        - **Persistent Threads**: Manages multiple `chat_sessions` with auto-titling.
        - **Referential Integrity**: Ensures every message belongs to a valid session (`ensureSession`).
        - **Ownership**: `chat_sessions.source` names the interface a chat belongs to; the dashboard lists web chats only (see [memory.md](memory.md)).
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
        - **What the agent's `/health` costs**: one `SELECT 1` and a stat of the WAL file per request. No request walks the database. The integrity scan (`PRAGMA quick_check`, which reads every page: 1.2 s on the device) runs in a worker thread on its own read-only connection (`apps/agent/src/utils/integrity-worker.js`), at most every 30 minutes (`HEALTH_INTEGRITY_MINUTES`; `0` turns it off), so it blocks neither the request nor the agent. A request reports the last result (`pending` until the first one lands). A `corrupt` result stays until a later scan clears it (a file too damaged to walk makes SQLite throw `SQLITE_CORRUPT`; that reads `corrupt` too). A scan that could not run is tried again within a minute: `error` when SQLite could not read the file, which marks the database unhealthy, and `unknown` when the check itself failed (the worker would not start, died, or gave no answer in two minutes), which does not. A worker stuck inside a read cannot be stopped from outside, so no new scan starts until it has exited. The scan used to run inside every health request and blocked the whole agent each time. The API waits two seconds for the agent, which must stay under the dashboard's three for the API.

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
    - `GET /v1/settings`: Read runtime settings. Secret-looking values come back as `{ __secret: true, set: boolean }` — the name and whether it is set, never the value.
    - `POST /v1/settings`: Update runtime settings (updates DB + Cache). Send a `{ __secret: true }` marker back for a secret you are not changing, `""` to clear it.
    - `GET /v1/backups`: Manage backup archives.
    - `GET /v1/logs/:container`: Stream real-time logs (SSE-like).
    - `POST /v1/whatsapp`: Control WhatsApp sessions (connect/disconnect).
    - `GET /v1/whatsapp/contacts`: Search synced WhatsApp contacts.
    - `GET/POST /v1/gsuite/*`: Google Workspace OAuth and Account Management.
    - `POST /v1/live/token`: Proxy for Gemini Live ephemeral tokens (`authTokens.create` on the Agent).
    - `GET /v1/live/config`: Proxy for the Live model, voice and the Agent's Live system instruction.
    - `POST /v1/live/tools/execute`: Proxy for Gemini Live client-side tool execution.
    - `GET /v1/vaults`: List and manage Life Vaults.
    - `GET /v1/browser-secrets`: Browser secret names only. `PUT`/`DELETE /v1/browser-secrets/<NAME>` set or remove one.
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
- **Socket.io Proxy**: `/socket.io` path is proxied to `interfaces:5000` via `http-proxy-middleware` with full WebSocket upgrade support. Browser clients send the session JWT cookie (`deedee_session`) issued by the web service. The API gateway verifies the JWT on every upgrade using the shared `SESSION_SECRET`, then injects `DEEDEE_API_TOKEN` into the upstream URL so Interfaces accepts the connection. The browser never holds the API token. Clients use `transports: ['websocket']` to keep traffic to a single WS upgrade per connection (no polling).
- **Auth**:
    - `/v1/*`: Bearer Token (`DEEDEE_API_TOKEN`). Used by iOS Shortcuts, cron jobs, and internal services.
    - `/socket.io`: Session JWT cookie (signed with `SESSION_SECRET`, shared with web).
    - `/health`: Public.
    - **CORS**: Scoped to `WEB_ORIGIN` with credentials enabled so the cookie can ride cross-subdomain in two-subdomain deployments.
- **Security**: All route parameters are encoded with `encodeURIComponent()` to prevent injection via crafted job names or IDs.
- **Flow**: Client -> API -> Agent (Waits for full processing) -> API -> Client JSON Response.


### 4. Interfaces (`apps/interfaces`)
- **Role**: The Ears and Mouth.
- **Port**: `5000`
- **Supported Channels**:
    - **Socket.io**: Real-time event-based communication for Web Interface. Browser clients connect via the API gateway (`/socket.io` proxy) which handles WebSocket upgrades.
        - **Auth**: Two paths, both backed by `DEEDEE_API_TOKEN`. Internal services (agent, browser screencast tools) connect with the token in `handshake.auth.token` and are marked `isTrusted` (only these can emit `browser:frame`). Browser clients receive the token from the API gateway as a query param after the API gateway has verified their session JWT cookie — they can connect but are NOT trusted.
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
    - **User**: Built-in `/login` page. Password (argon2-style scrypt hash in `auth.json`) plus optional WebAuthn passkeys. Sessions are signed JWT cookies (HS256 + `SESSION_SECRET`) with sliding 30-day expiry. Middleware (`src/middleware.js`) gates pages, image proxies, server actions, and `/api/*`. Self-service at `/settings/security`: enroll/rename/delete passkeys, change password, sign out. See [Authentication Setup](../README.md#-authentication-setup) for env vars and deploy recipes.
    - **Bootstrap & recovery**: `LOGIN_PASSWORD` env var is hashed into `auth.json` on every web boot — non-interactive setup *and* recovery if you forget the password. `npm run auth:init` is an interactive alternative.
    - **Service**: Injected `DEEDEE_API_TOKEN` for secure API communication (Server Actions). Cross-service `/internal/*` calls into the agent carry `DEEDEE_INTERNAL_TOKEN`, injected by a global axios interceptor in `apps/api` and `apps/interfaces`.
    - **Storage**: `auth.json` lives on the dedicated `web-data` Docker volume. Excluded from backups by design — recovery is "set `LOGIN_PASSWORD`, restart, re-enroll passkeys".

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
    -   API `/v1/*`: Bearer Token (`DEEDEE_API_TOKEN`). Used by iOS Shortcuts, cron, and internal services.
    -   Browser `/socket.io`: Session JWT cookie (signed with `SESSION_SECRET`, set by the web service after password or passkey login). The API gateway verifies the cookie on each WebSocket upgrade and injects `DEEDEE_API_TOKEN` into the upstream handshake so Interfaces accepts the connection. Internal services authenticate directly with `DEEDEE_API_TOKEN` in `handshake.auth.token`.
    -   Web UI: Self-contained `/login` page (password + passkey). Next.js middleware redirects unauthenticated requests; route handlers re-check via `requireSession()` for defense-in-depth.
    -   Agent, every route but `/health`: `DEEDEE_INTERNAL_TOKEN` bearer (one check at the top of `server.js`), on top of Docker network isolation. The gateway, the interfaces service, the web app's image proxies and the supervisor's deep check all send it.
    -   Telegram: `ALLOWED_TELEGRAM_IDS` allowlist.
3.  **Safety Mechanisms**:
    -   **Global Stop**: `/stop` command halts all active execution loops instantly.
    -   **Dictation Safeguard**: Heuristic checks for ambiguous voice input from iOS.
    -   **Sensitive Tool Guard**: "YOLO" mode but with confirmation requirements for high-risk actions if unsure (Refining).

### Self-Improvement Loop
1.  **Request**: "Add PDF support."
2.  **Planning**: Agent designs change.
3.  **Execution**: Agent edits `/app/source` with its file and shell tools.
4.  **Pull request**: `commitAndPush` asks the Supervisor, which runs a secret scan and a syntax check (no tests, no hooks), pushes a `deedee/self/<time>` branch and opens a pull request.
5.  **Verification**: CI runs the full suite on the pull request.
6.  **Deployment**: The owner merges -> GitHub Actions -> Balena Cloud -> Device Update. If the agent then fails its health checks, the Supervisor opens a revert pull request; it never pushes `master`.

## Persistence
-   **Agent**: SQLite Database (`agent.db`) for Chat History (hydrated on every turn).
-   **Filesystem**: Source code is persistent via volume mount.
