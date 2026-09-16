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
- `HEAD` is read with `git log -1 --pretty=format:%H%x09%ae%x09%s` through `execFile` (tab separated, no shell).
- The window opens only when all hold:
    1. `HEAD` differs from `.last_boot_commit` (a new commit since the last assessment).
    2. The author email of `HEAD` equals the Supervisor's git email (`GIT_USER_EMAIL`, default `supervisor@deedee.bot`).
    3. The subject of `HEAD` does not start with `Revert "`.
    4. The hash of `HEAD` is not the one stored in `.last_rollback_commit`.
- Otherwise `lastUpdate` stays `0`: the Supervisor alerts but never rolls back. Reboots, crashes, Balena deploys, owner merges and the Supervisor's own reverts do not open the window.
- The decision runs at start and again on every health check tick whose `HEAD` hash differs from the last assessed one (Balena restarts only services whose image changed). A re-assessment also updates `.last_boot_commit`.
- The Supervisor records the self-commit hash. `git.rollback({ expectedHead })` re-checks `HEAD` and aborts if it moved. After a successful revert the Supervisor stores the revert hash in `.last_rollback_commit` and refuses to roll that hash back.
- `.last_boot_commit` and `.last_rollback_commit` live in `SUPERVISOR_STATE_DIR` (default `/app/state`, volume `supervisor-state`), never in the shared `/app/source`. A legacy copy in `/app/source` is read once and copied over.
- `git commit` and `git revert` pass `-c user.name -c user.email` from the env, so repo config is irrelevant to authorship.
- `SUPERVISOR_AUTO_ROLLBACK=false` disables rollback. Alerts stay on.
- Every decision is logged.

## 3. Implementation Details

### Supervisor
- `Monitor` class:
    - `start()`: setInterval loop.
    - `check()`: fetch agent health.
    - `handleFailure()`: logic for alert/rollback.
