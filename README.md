# Deedee 🧠

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Enabled-blue.svg)](https://www.docker.com/)
[![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Google%20Gemini-orange.svg)](https://ai.google.dev/)
[![Maintenance](https://img.shields.io/badge/Maintained%3F-yes-green.svg)](https://github.com/diegosucaria/deedee/graphs/commit-activity)

![Deedee Personal Agent](docs/hero.png)

**The Self-Improving Personal AI Agent for Raspberry Pi**

Deedee is an autonomous, persistent AI companion optimized for **Raspberry Pi** (it can be deployed via **Balena Cloud**). It can also run on any Docker-capable host.
It connects to your life (Telegram, Calendar, Plex, Home) and can modify its own code to learn new skills.

---

## What is this? 🤔
- **A Personal Agent**: Optimized for a SINGLE user (You).
- **Self-Improving**: Can write code, install NPM packages, and fix its own bugs.
- **Persistent**: Remembers everything. Hydrates context from a local database.
- **Microservice Arch**: Runs on Docker. Modular (Agent, Supervisor, API).
- **Secure-ish**: Designed for personal use ("YOLO Mode"). It has shell access to get things done.

## What is it NOT? 🚫
- **NOT a SaaS**: You cannot deploy one instance for 100 users. It is single-tenant.
- **NOT a "Chatbot"**: It is an Agent. It takes actions, waits for results, and can run for minutes (or hours) to solve a problem.
- **NOT Production-Safe for Enterprise**: It allows the AI to freely run commands that it thinks will help (though we have guardrails).

---

## 🚀 Quickstart

### 1. Prerequisites
- **Docker** & **Docker Compose** installed.
- **Gemini API Key** (from Google AI Studio).
- **Telegram Bot Token** (from @BotFather).

### 2. Installation
```bash
# 1. Clone the repo
git clone https://github.com/diegosucaria/deedee.git
cd deedee

# 2. Configure Environment
cp .env.example .env
nano .env
# -> Fill in GOOGLE_API_KEY and TELEGRAM_TOKEN
# -> Set WORKER_GOOGLE_SEARCH=gemini-2.5-pro (for Search Tool)
# -> Set ALLOWED_TELEGRAM_IDS to your ID (get it from @userinfobot)

# 3. Launch
docker-compose up --build
```

### 3. Usage
Open Telegram and message your bot:
> *"Hello! Who are you?"*
> *"Check my calendar for tomorrow."*
> *"Create a new tool to fetch stock prices."* (Watch it code!)

---

## ✨ Features

- **🧠 Dual-Brain Logic**: Routes fast queries to `Gemini 2.5 Flash` and complex tasks to `Gemini 3 Pro`.

Everything is customizable via environment variables. Like which models to use.
  
  ![Dual Brain Architecture](docs/dual-brain.png)
  
- **💬 Persistent Chat Sessions**:
    - **Multi-Threaded**: Create multiple concurrent chats (like ChatGPT).
    - **Auto-Titling**: Automatically names your sessions based on context.
    - **History**: Full conversation history persisted and searchable.

- **💡 Smart Context & Memory**:
    - **Long-Term Memory**: Automatically compresses old conversations into summaries (`token_threshold` triggered) to maintain continuity without token bloat.
    - **Recal**: Agent can "search history" to recall specific details from months ago.
    - **Cost Aware**: Tracks and visualizes real-time token costs with exact pricing for Gemini Models (Flash/Pro) and Tiered Contexts.

- **🗣️ Native Voice**: Replies with high-quality, low-latency audio (WAV) using Gemini TTS.
- **🛡️ Supervisor System**: An external "immune system" service that detects if the Agent breaks itself and performs a rollback.

  ![Self-Healing Loop](docs/self-healing.png)

- **🔌 MCP Integration**: Supports Model Context Protocol.
    - **Home Assistant**: "Turn on the living room light" or "Set the temperature to 22°C". Active and integrated.
    - **Plex**: "Play the movie Inception" or "Recommend me a movie I haven't seen"/
    - **GSuite**: "Calendar", "Gmail".
    - **Local**: Shell, Filesystem.
- **📱 API Gateway**: Synchronous API (`POST /v1/chat`) for iOS Shortcuts and Dashboards. Includes **Dictation Safeguards** for voice input.
- **🏠 Smart Home Intelligence**:
    - **Entity Memory**: Remembers your device names ("hallway light" → `light.hallway_main`).
    - **Adaptive Control**: Smart logic (e.g., "Turn On" always sets brightness to 100%).
-   **Goals System**: Long-term memory for multi-step projects ("Refactor auth", "Plan vacation"). Persists across restarts.
-   **Security & backups**:
    -   **Nightly Backups**: Automatically zips and uploads data to Google Cloud Storage.
    -   **System Jobs**: Protected maintenance tasks (backup, consolidation) differentiated from user jobs in stats.
- **Refactored Architecture**: Modular `ToolExecutor` with domain-specific handlers for easier extensibility.
-   **⚡ Productivity**:
    -   **Smart Notes**: "Note to self: buy milk" saves to a daily markdown journal.
    -   **Second Brain**: Searchable journal entries (`readJournal`, `searchJournal`).
    -   **Smart Reminders**: "Remind me to call Mom at 5pm" (One-off, auto-deleting tasks).
    -   **Morning Briefing**: `GET /v1/briefing` generates a concise audio-ready summary of your day.
-   **🛑 Safety**: Global `/stop` command instantly kills any runaway agent loops.
-   **💬 WhatsApp**: Full integration with **Dual Session** support (Assistant + User) and **Contact Search**.
-   **🎙️ Gemini Live**: Real-time, low-latency voice interaction via the Web UI.
    -   **Interruptible**: Natural conversations.
    -   **Tool-Enabled**: Can use all agent tools (e.g. "Send a WhatsApp to Alice").
    -   **Configurable Voice**: Choose from multiple personas (Puck, Kore, Charon) via Settings.
-   **⚙️ Runtime Settings Manager**:
    -   **Dynamic Configuration**: Change voice, search strategy, and system behaviors on-the-fly without restarting.
    -   **In-Memory Caching**: Ultra-low latency access for core tools.
-   **📞 Dual-Brain WhatsApp**:
    -   **Assistant Mode**: The bot replies to you.
    -   **User Mode**: The bot acts *as you* (e.g. "Tell Mom I'll be late") using your linked device session.

-   **👥 People & Contacts**:
    -   **Smart Learn**: AI automatically analyzes your WhatsApp history to identify key contacts and relationships.
    -   **Unified UI**: Manage contacts, add notes, and view avatars in a beautiful grid layout.
    -   **Agent Aware**: The agent knows who your "Mom" or "Best Friend" is and can contact them appropriately.

-   **🗄️ Life Vaults**:
    -   **Topic-Based Knowledge**: Persistent file storage and wiki for specific life areas (e.g. "Health", "Finance", "Car").
    -   **Context Switching**: Agent automatically switches context when discussing a vault topic.
    -   **File Management**: Upload invoices, medical reports, or manuals. The Agent can find and read them.
    -   **Wiki**: Auto-updating `index.md` for each vault acting as a high-level summary.

---

##  Tools & Capabilities

Deedee comes equipped with a suite of tools, both internal and via MCP.

### Internal Tools
-   **System**: `runShellCommand`, `readFile`, `writeFile`, `listDirectory`.
-   **Git/Self-Improvement**: `pullLatestChanges`, `commitAndPush`, `rollbackLastChange`.
-   **Memory**: `rememberFact`, `getFact`.
-   **Goals**: `addGoal`, `completeGoal` (Track long-running tasks).
-   **Journal**: `logJournal`, `readJournal`, `searchJournal` (Second Brain).
-   **Scheduling**: `scheduleJob` (Cron), `setReminder` (One-off).
-   **Communication**: `replyWithAudio` (Native TTS), `sendEmail`.
-   **Productivity**: `listEvents` (Calendar).
-   **Life Vaults**: `createVault`, `addToVault` (Ingest files), `readVaultPage`, `listVaultFiles` (RAG-lite).

### MCP Servers (Model Context Protocol)
-   **Plex**: Media library search and status (`plex_mcp_server`).
-   **Home Assistant**: Control smart home devices (`ha-mcp`).
-   *(More can be added via `apps/agent/mcp_config.json`)*

---

## 🤖 Telegram & WhatsApp Setup

Deedee supports both Telegram and WhatsApp (via Baileys).

### Telegram
1.  **Create Bot**: Use **@BotFather** to get a `TELEGRAM_TOKEN`.
2.  **Allowlist**: Use **@userinfobot** to get your ID -> `ALLOWED_TELEGRAM_IDS`.

### WhatsApp
1.  **Settings**: Go to `/settings` (or Settings page) on your dashboard.
2.  **Connect**: Click "Connect" in the WhatsApp section to generate a QR Code.
3.  **Secure**: Set `ALLOWED_WHATSAPP_NUMBERS` in `.env` (comma-separated).

👉 **[Read the Interfaces Guide](docs/interfaces.md)** for full details.

---

## 📱 iOS Shortcut Setup

You can talk to Deedee via Siri using Apple Shortcuts.

1.  **Create a new Shortcut**.
2.  **Add "Get Contents of URL"**.
3.  **URL**: `https://<your-api-url>/v1/chat` (or `http://raspberrypi.local:3001/v1/chat` if local).
4.  **Method**: `POST`.
5.  **Headers**:
    *   `Authorization`: `Bearer <YOUR_DEEDEE_API_TOKEN>`
    *   `Content-Type`: `application/json`
6.  **Request Body (JSON)**:
    ```json
    {
      "message": "Text (or 'Dictated Text' variable)",
      "source": "iphone",
      "chatId": "ios_shortcut"
    }
    ```
7.  **Parse Response**:
    *   Get `agentResponse.replies` from the result.
    *   Iterate and Speak/Show the content.

> **Tip**: Setting `source: iphone` enables special safeguards where Deedee will ask for clarification if your dictation is garbled.

## 🌅 Morning Briefing Setup

To wake up to a personalized summary:
1.  Create an iOS Automation (e.g., "When Alarm Stops").
2.  Add "Get Contents of URL":
    -   **URL**: `https://<your-api-url>/v1/briefing`
    -   **Method**: `GET`
    -   **Headers**: `Authorization: Bearer <TOKEN>`
3.  Parse JSON response (`Dictionary` -> `Value for key 'briefing'`).
4.  Add "Speak Text" action.

## 🏙️ City Weather Lock Screen

To generate a dynamic wallpaper:
1.  **URL**: `https://<your-api-url>/v1/city-image?city=London`
2.  **Method**: `GET`
    - Response is a binary PNG image.
3.  **Shortcut Action**: "Set Wallpaper" or "Save to Photo Album".

## 💻 API Usage Examples

You can interact with Deedee from your terminal or any HTTP client.

### 1. Chat (Text)
```bash
curl -X POST http://localhost:3001/v1/chat \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message": "Check my calendar for today"}'
```

### 2. Morning Briefing (Audio Text)
```bash
curl -X GET http://localhost:3001/v1/briefing \
  -H "Authorization: Bearer <YOUR_TOKEN>"
# Returns: {"success": true, "briefing": "Good morning! It's 20°C in Córdoba..."}
```

### 3. City Weather Wallpaper (Image)
```bash
curl -X GET "http://localhost:3001/v1/city-image?city=Tokyo" \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  --output wallpaper.png
# Saves 'wallpaper.png' to current directory
```

---

## 🛠️ Architecture

See the full documentation for details:

![System Architecture](docs/diagram.png)

-   **[Architecture Deep Dive](docs/architecture.md)**: Detailed system map and component breakdown.
-   **[Technical Sequence Diagrams](docs/sequence-diagrams.md)**: Visualizing the API Flow and MCP Execution.
-   **[Memory & Persistence](docs/memory.md)**: How the SQLite database and "Self-Improvement" Works.
-   **[MCP Configuration](docs/mcp-configuration.md)**: Guide to adding external tools (Home Assistant, Plex, etc).
-   **[Security Model](docs/security.md)**: Details on "YOLO Mode", threat models, and access control.
-   **[Docker Optimization](docs/docker-optimization.md)**: Explanation of Turbo Prune builds and caching strategy.
-   **[Tools Master Plan](docs/tools-master-plan.md)**: Status and roadmap of all internal tools.

1.  **Agent**: Node.js + LangChain/Gemini.
2.  **Supervisor**: Watchdog + Git Operations.
3.  **API**: Express Gateway.
4.  **Interfaces**: Telegram Polling Bot.

## 📄 License

MIT License. See [LICENSE](LICENSE) file.

---

## 👨‍💻 Developer Notes & AI Context

> [!IMPORTANT]
> **NOTE TO AI AGENTS**: Before designing or implementing new features (especially related to Audio, Search, or Real-time APIs), **YOU MUST READ THIS SECTION**. It contains critical constraints and patterns discovered through hard-fought debugging. Ignore them at your own peril.

### 1. Audio Generation (Gemini API)
- **Constraint**: The `generateContent` method with `responseModalities: ['AUDIO']` **DOES NOT** support the `responseMimeType` parameter (e.g., `audio/mp3` throws `INVALID_ARGUMENT`).
- **Solution**: The API returns raw PCM/WAV-like buffer. You **MUST** wrapping it with a valid **WAV Header (RIFF)** (24kHz, 1ch, 16-bit) using `apps/agent/src/utils/audio.js` -> `createWavHeader` before sending it to the client.

### 2. Runtime Settings (Read-Through Cache)
- **Pattern**: Core logic (like `MediaExecutor`) needs synchronous access to settings (e.g., `voice`). DB access is too slow/risky for every call.
- **Solution**: 
    1. `Agent.loadSettings()` loads rows into `agent.settings` (in-memory) at boot.
    2. Updates via `POST /settings` write to DB **AND** refresh the in-memory cache immediately.
    3. Always access `this.services.agent.settings[key]` first.

### 3. Live API (WebSockets)
- **Constraint**: The Live API schema validation is incredibly strict. It forbids `additionalProperties` and certain `$ref` structures.
- **Solution**: Use the `cleanSchema` utility in `apps/web/src/app/live/page.js` to strip unauthorized keys before sending tools.
- **Handshake**: Voice preferences **MUST** be sent in the initial `setup` message.

### 4. Search Strategy (Hybrid)
- **Constraint**: Native `googleSearch` (Grounding) **CANNOT** be combined with functional tools (like TTS) in the same turn.
- **Solution**: `agent.js` implements a **Hybrid Strategy**:
    - **Text Context**: Uses Native Grounding (Better citations).
    - **Audio Context**: Uses a Polyfill Tool (`google_search`) to allow mixing with `replyWithAudio`.

### 5. Multi-Brain Architecture (WhatsApp)
- **Pattern**: To support "acting as user" vs "acting as assistant", we maintain TWO distinct Baileys sessions.
- **Critical Gotchas**:
    1. **JID Formatting**: Baileys is strict. IDs must be `number@s.whatsapp.net`. You **MUST** strip `+` signs from phone numbers before appending the suffix.
    2. **Store Polyfill**: The `@whiskeysockets/baileys` package does *not* correctly export `makeInMemoryStore` in the CJS build. We implemented a manual polyfill/binding in `apps/interfaces/src/whatsapp.js` to ensure contact syncing works. Do not blindly import it.
    3. **"Me" Handling**: Messages sent *by* the user (via phone) appear in the stream. We must filter them out to prevent the agent from replying to itself, unless specifically in "listening" mode.

### 6. Real-Time Strategy (SSE vs Socket.io)
- **Pattern**: Choosing the right transport for the job.
- **Server-Sent Events (SSE)**: Use for **Unidirectional** streams (e.g., `GET /v1/logs`). Lighter, native auto-reconnect, traversing proxies easily.
- **Socket.io**: Use for **Bidirectional** state (e.g., Chat, "Thinking" indicators).

### 7. Frontend Security (Server Actions & Config)
- **Constraint**: The `DEEDEE_API_TOKEN` gives full control over the agent.
- **Rule**: NEVER expose it - or the API URL - to the client bundle (no `NEXT_PUBLIC_` env vars for sensitive configs).
- **Solution**: 
    1. Use **Next.js Server Actions** (`apps/web/src/app/actions.js`) as a secure proxy for data fetching.
    2. Use **Next.js Rewrites** (`next.config.mjs`) to proxy client-side requests (like images/socket) to backend services. 
    3. **DO NOT** use `process.env.NEXT_PUBLIC_API_URL` in React components. Use relative paths (e.g., `/api/...`).
