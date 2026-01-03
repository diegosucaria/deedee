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

### Capabilities & Tools
- [x] **Plex Integration**: "Play Inception", "What's on deck?".
- [x] **Smart Home**: Home Assistant control with entity memory and adaptive logic.
- [x] **Productivity**:
    - **Smart Notes**: Daily journal logging.
    - **Morning Briefing**: `GET /v1/briefing` for spoken summaries.
    - **City Weather Art**: `GET /v1/city-image` for dynamic wallpapers.
- [x] **GSuite**: Calendar and Email access.
- [x] **Security**: Allowlist (`ALLOWED_TELEGRAM_IDS`), "YOLO" mode with guardrails.

---

## 🚧 Future Roadmap / Ideas

### Interfaces
- [ ] **WhatsApp**: Integration via Twilio or Meta API.
- [ ] **Slack**: Native app integration (currently just webhooks).
- [ ] **Web Dashboard**: A React frontend for the API Gateway.

### Intelligence
- [ ] **Vector Memory**: Migrate from SQLite Regex search to Embeddings/Vector Store (pgvector/Chroma).
- [ ] **Local RAG**: Ability to ingest and index local PDFs/Docs.
- [ ] **Multi-Agent**: Spawning specialized sub-agents for research tasks.

### Infrastructure
- [ ] **Kubernetes**: Migrate from Docker Compose (maybe overkill for Pi?).
- [ ] **Voice Cloning**: Use ElevenLabs or OpenVoice for custom TTS identities.
- [ ] **Optimize MCP Startup**: Bake `ha-mcp` into Docker image to avoid `uvx` runtime download.