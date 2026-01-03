# Productivity & Proactivity Features

## 1. Smart Logging ("Note to Self")
**Goal**: Allow the user to quickly log thoughts/todos to a persistent file without them getting lost in the chat history.

### Implementation
-   **Tool**: `logJournal(content)`
-   **Storage**: `/app/data/journal/YYYY-MM-DD.md`
-   **Format**: `[HH:MM] {content}`
-   **Behavior**: When user says "Note to self: buy milk", Agent calls `logJournal("buy milk")`.

## 2. Task Scheduler (Infrastructure)
**Goal**: Enable the Agent to perform recurring actions (proactivity).

### Implementation
-   **Library**: `node-schedule`.
-   **Class**: `Scheduler` (in `apps/agent/src/scheduler.js`).
-   **Tool**: `scheduleTask(cronExpression, taskDescription)`
    -   *Note*: For v1, this tool might just save to DB. The `Scheduler` needs to load these on startup.
    -   *Simplification*: The user said "no tasks will be scheduled for now", just "build the code".
    -   **Approach**: We will build the `Scheduler` class that *can* run jobs. We will wire it up to `agent.js`. We will *not* add any default jobs yet.

## 3. Morning Briefing API
**Goal**: A dedicated endpoint for iOS Shortcuts to fetch a briefing.

### API Contract
-   **Endpoint**: `GET /v1/briefing`
-   **Auth**: Bearer Token (same as chat).
-   **Response**:
    ```json
    {
      "success": true,
      "briefing": "Good morning Diego. It is 68 degrees. You have 3 meetings..."
    }
    ```

### Internal Logic
1.  API receives `GET /v1/briefing`.
2.  API constructs a special prompt:
    > "Generate a Morning Briefing for user.
    > 1. Check the weather (if tool avail, else skip).
    > 2. Check calendar for today (`listEvents`).
    > 3. Check pending goals (`getPendingGoals`).
    > 4. Summarize clearly and concisely for spoken audio.
    > 5. Do NOT output 'Thinking...' intermediate steps, just the final result."
3.  API sends this to Agent via existing internal chat mechanism.
4.  Agent runs tools (Calendar, etc) and returns final text.
5.  API returns text.
