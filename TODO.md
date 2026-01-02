# Deedee Project Roadmap

## Phase 1: Core Foundation (Completed)
- [x] **Implement Spec 001: Core Agent Hello World**
- [x] **Spec 002: Supervisor & IPC**
- [x] **Spec 003: Telegram Interface**
- [x] **Spec 004: HTTP IPC Integration**
- [x] **Spec 005: MCP GSuite**
- [x] **Spec 008: Local System MCP**

## Phase 2: Reliability & Persistence (Current)
- [ ] **Deploy to Balena and Verify** (Ongoing)
- [ ] **Spec 009: Agent Persistence (SQLite)**
  - [ ] DB Schema (History, Goals)
  - [ ] Context Loading on Boot
- [ ] **Spec 010: Supervisor Pre-Flight Checks**
  - [ ] Run `npm test` before `git push`
  - [ ] Syntax validation
- [ ] **Refactor Agent**
  - [ ] Split Tools Registry

## Phase 3: Enhanced Capabilities
- [ ] **Spec 006: Supervisor Self-Test & Rollback**
- [ ] **Spec 007: WhatsApp Interface**
