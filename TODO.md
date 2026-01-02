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
- [ ] **Spec 013: Router Architecture & Chat Hydration**
  - [ ] Implement AgentDB Hydration (`getHistoryForChat`)
  - [ ] Implement Router Logic (Prompt & Parsing)
  - [ ] Refactor Agent to Stateless/Hydrated Loop
- [ ] **Spec 006: Supervisor Self-Test & Rollback**
- [ ] **Spec 007: WhatsApp Interface**