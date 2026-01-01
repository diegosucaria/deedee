# Spec 002: Supervisor & IPC

## Objective
Establish the `Supervisor` as the privileged "Git Operator" and setup HTTP communication between Agent and Supervisor.

## Components

### 1. Supervisor Server (`apps/supervisor`)
A lightweight Express server listening on port 4000 (internal).

**Endpoints:**
- `GET /health`: Returns `{ status: 'ok', version: '...' }`
- `POST /cmd/commit`: Accepts `{ message: string, files: string[] }`.
    - Stages files.
    - Commits with the given message.
    - Pushes to remote.

### 2. IPC Client (`packages/shared/src/ipc.js`)
A helper class for the Agent to talk to the Supervisor.

**Interface:**
```javascript
class SupervisorClient {
  constructor(baseUrl);
  async commitAndPush(message, files);
}
```

## Scenario: Agent Self-Correction

**Given** the Agent has modified a file in `/app/source` (shared volume).
**When** the Agent calls `SupervisorClient.commitAndPush('fix: bug')`.
**Then** the Supervisor should execute the git commands successfully.

## Implementation Plan
1. Create `packages/shared/src/ipc.js`.
2. Create `apps/supervisor/src/git-ops.js` (Git wrapper).
3. Create `apps/supervisor/src/server.js` (Express app).
4. Create test `apps/supervisor/tests/server.test.js`.
