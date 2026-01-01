# Deedee Project Roadmap

## Phase 1: Core Foundation (Current)
- [ ] **Implement Spec 001: Core Agent Hello World**
  - [ ] Create `packages/shared/src/types.ts` (Message definitions)
  - [ ] Create `packages/interfaces/src/mock.ts` (Test interface)
  - [ ] Create `apps/agent/src/agent.ts` (Main logic)
  - [ ] Write & Pass `apps/agent/tests/smoke.test.ts`
- [ ] **Dockerize Core**
  - [ ] Create `apps/agent/Dockerfile`
  - [ ] Verify local build

## Phase 2: The Supervisor (Self-Improvement)
- [ ] **Spec 002: Supervisor & IPC**
  - [ ] Define API between Agent and Supervisor
  - [ ] Implement `apps/supervisor` basic server
- [ ] **Container Management**
  - [ ] Implement Docker Socket control in Supervisor
  - [ ] Test Supervisor restarting Agent

## Phase 3: Capabilities (MCP)
- [ ] **MCP Infrastructure**
  - [ ] Set up `@deedee/mcp-servers`
  - [ ] Implement Client in Agent to consume MCP
- [ ] **Specific Servers**
  - [ ] `mcp-local`: Safe file reading/writing
  - [ ] `mcp-gsuite`: Google Calendar/Gmail integration

## Phase 4: Interfaces (The "Body")
- [ ] **Telegram Connector**
  - [ ] Implement `@deedee/interfaces/telegram`
  - [ ] Setup Webhook handling
- [ ] **Slack Connector** (Future)

## Phase 5: Security & Deployment
- [ ] **Secret Management** strategy implementation
- [ ] **Nginx/Reverse Proxy** setup
- [ ] **Raspberry Pi** deployment script
