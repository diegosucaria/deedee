# Deedee Project Roadmap

## Phase 1: Core Foundation (Completed)
- [x] **Implement Spec 001: Core Agent Hello World**
  - [x] Shared Types & Mock Interface
  - [x] Agent Logic & Smoke Test
- [x] **Spec 002: Supervisor & IPC**
  - [x] Supervisor Express Server
  - [x] Git Operations Wrapper
  - [x] Shared IPC Client
- [x] **Spec 003: Telegram Interface**
  - [x] Polling Service
  - [x] Outgoing Message Endpoint
- [x] **Spec 004: HTTP IPC Integration**
  - [x] Agent Webhook Server
  - [x] HttpInterface Adapter
- [x] **Spec 005: MCP GSuite**
  - [x] Calendar & Gmail Tools
  - [x] Agent Tool Integration

## Phase 2: Deployment & Stability (Current)
- [ ] **Deploy to Balena and Verify**
  - [x] CI/CD Pipeline Setup
  - [ ] Verify End-to-End on Device
- [ ] **Spec 006: Supervisor Self-Test & Rollback**
  - [ ] Implement Health Checks
  - [ ] Implement Rollback Logic

## Phase 3: Enhanced Capabilities
- [ ] **Spec 008: Local System MCP**
  - [ ] File System Access (Safe Mode)
  - [ ] Command Execution
- [ ] **Spec 007: WhatsApp Interface**
  - [ ] Baileys Integration

## Phase 4: Long-Term Memory
- [ ] **SQLite Integration**
  - [ ] Conversation History
  - [ ] Fact Storage