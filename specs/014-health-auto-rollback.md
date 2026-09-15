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

### 2.4 Rollback Window Rule (added 2026-09)
- The window opens on start only when both hold:
    1. `HEAD` differs from `.last_boot_commit` (a new commit since the last boot).
    2. The author email of `HEAD` equals the Supervisor's git email (`GIT_USER_EMAIL`, default `supervisor@deedee.bot`).
- Otherwise `lastUpdate` stays `0`: the Supervisor alerts but never rolls back. Reboots, crashes, Balena deploys and owner merges do not open the window.
- The Supervisor records the self-commit hash at start. `git.rollback({ expectedHead })` re-checks `HEAD` and aborts if it moved.
- `SUPERVISOR_AUTO_ROLLBACK=false` disables rollback. Alerts stay on.
- The decision is logged at start.

## 3. Implementation Details

### Supervisor
- `Monitor` class:
    - `start()`: setInterval loop.
    - `check()`: fetch agent health.
    - `handleFailure()`: logic for alert/rollback.
