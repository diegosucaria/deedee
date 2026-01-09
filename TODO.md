# Deedee Project Roadmap 🗺️

## ✅ Completed Features

### Core Architecture
- [x] **Microservices**: Agent, Supervisor, API, Interfaces (Docker).
- [x] **Dual-Brain Logic**: Routing to `Gemini 2.5 Flash` (Speed) and `Gemini 3 Pro` (Intelligence).
- [x] **Self-Healing**: Supervisor service monitors Agent health and performs Git rollbacks on failure.
- [x] **Self-Improvement**: Agent can commit code, install dependencies (`npm`/`pip`), and restart itself.

### Interfaces
- [x] **Telegram**: Text and Native Voice (WAV) support.
- [x] **API Gateway**: Synchronous `POST /v1/chat` for iOS Shortcuts & Dashboards.
- [x] **Web Dashboard**: Next.js interface with Real-time Chat, Journal, and Memory views.
- [x] **WhatsApp**: Integration via Baileys (Dual Session: User & Assistant).

### Capabilities & Tools
- [x] **Plex Integration**: "Play Inception", "What's on deck?".
- [x] **Smart Home**: Home Assistant control with entity memory and adaptive logic.
- [x] **Productivity**:
    - **Smart Notes**: Daily journal logging.
    - **Morning Briefing**: `GET /v1/briefing` for spoken summaries.
    - **City Weather Art**: `GET /v1/city-image` for dynamic wallpapers.
- [x] **GSuite**: Calendar and Email access.
- [x] **Web & Admin Refactor**:
    - [x] Secured API with `DEEDEE_API_TOKEN` and Middleware.
    - [x] Backend Persistence for Scheduled Jobs (SQLite).
    - [x] Full CRUD support for Goals, Facts, History, Aliases.
    - [x] Web UI: Edit Journal, Delete History, Polling WebSocket Fallback.
    - [x] Fixed TTS: Corrected `GEMINI_TTS_MODEL` usage and Audio Message delivery.
- [x] **Security**: Allowlist (`ALLOWED_TELEGRAM_IDS`), "YOLO" mode with guardrails.
- [x] **Backup**: Configurable Nightly GCS Backup (Zip + Rotate).
- [x] **Smart Context**:
    - [x] Auto-summarization of long chats (Long-term memory).
    - [x] Real-time Cost Tracking on stats dashboard.
    - [x] `searchHistory` tool for deep recall.
- [x] **DevOps & Infrastructure**:
    - [x] **Docker Optimization**: "Double Prune" strategy for cached builds (minutes -> seconds).
    - [x] **Native Modules**: Fixed `better-sqlite3` builds on Alpine.
    - [x] **Web Assets**: Updated Logos, Favicons, and Metadata.
- [x] **WhatsApp Improvements**:
    - [x] **Ghost Mode**: Disabled auto-read receipts.
    - [x] **Session Persistence**: Fixed Docker volume mounting.
    - [x] **LID Support**: Fixed blocking of Linked Identity messages.
- [x] **Enhanced Intelligence**:
    - [x] **Message Watchers**: Passive monitoring of 'user' session with conditional triggers.
    - [x] **Dual Session Logic**: 'Assistant' (Strict) vs 'User' (Passive/Mirror).
    - [x] **Conversation Tools**: `listConversations`, `readChatHistory`.

---

## 🚧 Future Roadmap / Ideas

### Interfaces
- [ ] **Automated Message Intros**: Add "I am DeeDee" introduction to automated/scheduler messages sent as User.
- [ ] **Voice Interface**: Real-time Gemini Live API integration (Web).
- [ ] **Chat Sessions**: Persistent history, threads, and management UI (ChatGPT-style).
- [ ] **Slack**: Native app integration (currently just webhooks).

### Intelligence
- [ ] **Vector Memory**: Migrate from SQLite Regex search to Embeddings/Vector Store (pgvector/Chroma).
- [ ] **Local RAG**: Ability to ingest and index local PDFs/Docs.
- [ ] **Multi-Agent**: Spawning specialized sub-agents for research tasks.

### Infrastructure
- [ ] **Kubernetes**: Migrate from Docker Compose (maybe overkill for Pi?).
- [ ] **Voice Cloning**: Use ElevenLabs or OpenVoice for custom TTS identities.
- [ ] **Optimize MCP Startup**: Bake `ha-mcp` into Docker image to avoid `uvx` runtime download.
- [ ] **Knowledge Base ("Second Brain")**: Integration with Obsidian/Notion for long-term knowledge management.
- [ ] **Long-term Persistence**: Dedicated storage for files (PDFs, Images) and structured data (Health, Financial) for longitudinal analysis.
- [x] **Chat Streaming**: Re-enable streaming responses (Completed).

### Recent Improvements (Jan 2026)
- [x] **Smart Notifications**: Configurable channel (WhatsApp/Telegram) and heuristic silence for recurring tasks.
- [x] **Settings UI**: Reorganized settings into tabs (General, Communication, Interfaces, Backups) and added UI for new features.
- [x] **Contact Import**: Added Import CSV/WhatsApp feature to People page.
- [x] **Validation**: Enhanced API validation for configuration keys.
- [x] **Deduplication**: Fixed double tool execution bug in Agent.