# Spec 045: Job Enable/Disable Toggles

## Goal
Enable users to selectively pause and resume specific Jobs (both User generated and System internal) from the web dashboard. Additionally, ensure all times rendered on the UI explicitly format dates using the server's local timezone via the `TZ` environment variable.

## Requirements

### Backend / Core
1. **DB Schema**: `scheduled_jobs` table requires an `enabled` column (Boolean / Integer default 1) to remember states across restarts.
2. **Backward Compatibility**: `ensureSystemJobs` sets default enabled state, but if a System Job was manually disabled by a user, that state MUST NOT be overwritten upon node initialization.
3. **Execution Safety**: `node-schedule` Jobs where `enabled=false` must be explicitly cancelled, while retaining the payload locally inside memory `agent.scheduler.jobs[x]` so the UI can fetch and display them as paused.
4. **API Endpoints**: Provide a `POST /v1/tasks/:name/toggle` route.

### Frontend / Dashboard
1. **Timezone Support**: Propagate `process.env.TZ` server-side down into `<TasksClient serverTz={...} />` and format `Date` components via `{ timeZone: serverTz }` to prevent timezone mismatch between browser and RPi.
2. **UI Interactivity**: Switch input or "Pause/Resume" action button alongside existing Run and Trash buttons on the Active Tasks Table and System Tasks sections.
3. **Optimistic Updates**: API request `toggleTask(name, enabled)` fires, waits for success, and calls Next.js Server Action `revalidatePath('/tasks')`.

## Test Scenarios
- Toggling a job disables the `node-schedule` invocation without deleting the DB record.
- Toggling a job back on reschedules the existing rule correctly.
- Disabling a system job (e.g. `daily_commitments`) survives a PM2/Docker container restart.
