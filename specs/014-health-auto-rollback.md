# Spec 014: Health & Auto-Rollback

## 1. Overview
Ensure the Agent is alive and functioning. If the Agent becomes unresponsive (especially after an update), the Supervisor should take action to restore service, either by alerting the user or automatically rolling back the last change.

## 2. Requirements

### 2.1 Health Check
- **Agent Endpoint**: `GET /health` (Already exists).
- **Supervisor Monitor**:
    - Poll `AGENT_URL/health` every `HEALTH_CHECK_INTERVAL` (default: 60s).
    - Track failures.

### 2.2 Failure Definitions
- **Unresponsive**: Agent returns 503 or times out.
- **Crash Loop**: Agent restarts frequently (Docker logic, but Supervisor sees it as intermittent failures).

### 2.3 Actions
1.  **Alerting (Tier 1)**
    - If `failures >= 3`: Send message to User via `INTERFACES_URL` (bypassing Agent).
    - Message: "⚠️ Agent is unresponsive. Checks failed: 3."

2.  **Auto-Rollback (Tier 2 - Advanced)**
    - If `failures >= 5` AND `last_update_time < 10 minutes ago`:
    - Trigger `git.rollback()`.
    - Notify User: "🔄 Detective detected a crash after update. Rolling back changes..."

## 3. Implementation Details

### Supervisor
- `Monitor` class:
    - `start()`: setInterval loop.
    - `check()`: fetch agent health.
    - `handleFailure()`: logic for alert/rollback.
