# Deedee Project Roadmap

## Phase 1: Core Foundation (Completed)
- [x] **Implement Spec 001: Core Agent Hello World**
- [x] **Spec 002: Supervisor & IPC**
- [x] **Spec 003: Telegram Interface**
- [x] **Spec 004: HTTP IPC Integration**
- [x] **Spec 005: MCP GSuite**
- [x] **Spec 008: Local System MCP**

## Phase 2: Reliability & Persistence (Current)
- [x] **Spec 009: Agent Persistence (SQLite)**
- [x] **Spec 011: Post-Update Notification**
- [x] **Spec 010: Supervisor Pre-Flight Checks**
  - [x] Run `npm test` before `git push`
  - [x] Syntax validation
- [x] **Refactor Agent**
  - [x] Split Tools Registry into `tools-definition.js`
- [x] **Fix: Supervisor Git Initialization (Missing `git pull`)**
- [x] **Feat: Shell Command Security Model (Blacklist instead of Whitelist)**
- [x] **Deploy to Balena and Verify**

## Phase 3: Enhanced Capabilities
- [x] **Feature: Agent Rate Limiting**
  - [x] DB Schema for Usage Tracking
  - [x] Token Limit Logic
- [x] **Feature: Loop Prevention (Safety)**
- [x] **Feature: "Thinking" State Notification**
- [x] **Improvement: Tool Feedback & Null Handling**
- [x] **Spec 013: Router Architecture & Chat Hydration**
  - [x] Implement AgentDB Hydration (`getHistoryForChat`)
  - [x] Implement Router Logic (Prompt & Parsing)
  - [x] Refactor Agent to Stateless/Hydrated Loop
- [x] **Spec 006: Supervisor Rollback**
  - [x] Implement `POST /cmd/rollback`
  - [x] Implement `git revert` logic
  - [x] Add `rollbackLastChange` tool to Agent
- [x] **Spec 014: Health & Auto-Rollback**
  - [x] Implement Supervisor Monitor class
  - [x] Implement Alerting Logic
  - [x] Implement Auto-Rollback Logic
- [x] **Feature: Supervisor Slack Alerts**
  - [x] Add `SLACK_WEBHOOK_URL` to Docker Compose (managed externally)
  - [x] Update Monitor to post to Webhook
- [ ] **Spec 007: WhatsApp Interface**
- [ ] **Spec 015: Slack- [x] **Agent Basics**:
    - [x] Basic "Hello World" (Telegram -> Agent -> LLM -> Telegram).
    - [x] Router Logic (Flash for fast/tools, Pro for complex).
    - [x] Rate Limiting (Prevent $1000 bills).
    - [x] Context Hydration (SQLite / Vector DB basics).
    - [x] Date Awareness (Inject system time).
    - [x] **Architecture & Performance**:
        - [x] MCP Tool Caching (Fast startup/tools).
        - [x] Context-Aware Routing (History + Multimodal).
        - [x] Security Allowlist (`ALLOWED_TELEGRAM_IDS`).
- [ ] **Interfaces**:
    - [x] Telegram (Text & Voice).
    - [ ] WhatsApp (Twilio). (Priority: Check cost first).protocol/sdk`
  - [x] Implement `MCPManager` (Stdio Transport)
  - [x] Refactor `Agent.js` to Hybrid Tool System (Merged Tools)
  - [x] Configure Home Assistant Server (`mcp_config.json`)
  - [x] Configure Home Assistant Server (`mcp_config.json`)
  - [x] **Spec 019: Plex Integration**
    - [x] Clone `vladimir-tutin/plex-mcp-server`
    - [x] Configure `mcp_config.json` with `python3` and `cwd`
    - [x] Dockerfile dependency update (venv + uv)
    - [x] **Guardrails**: Implement Spec 017 (Confirmation for Destructive Tools)
  - [x] **Spec 020: API Service (Microservice)**
    - [x] Create `apps/api` with Express & Bearer Auth
    - [x] Connect to Agent via Webhook