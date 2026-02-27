# Proactive Agent Loop

## Goal
Implement a recurring, probabilistic background loop where the Agent has "free time" to think, review its context, and potentially initiate conversation with the user (or perform other background tasks) without being explicitly prompted.

## Architecture

1.  **Scheduler Integration**:
    *   Add a new system job `proactive_thought` in `apps/agent/src/scheduler.js`.
    *   **Schedule**: `0 * * * *` (Every hour on the hour).
    *   **Probabilistic Execution**: Inside the job's callback, implement a random check (e.g., `Math.random() < 0.125`). If the check fails, the job immediately returns without invoking the LLM. This ensures the agent isn't predictable and saves tokens/costs, averaging ~3 executions per day.

2.  **The Prompt (Instruction)**:
    *   The task payload will be a carefully crafted prompt instructing the agent on its current state ("free time") and its options.
    *   **Crucially**, the prompt will include strict Safety/Boundary rules.

3.  **Safety & Boundaries**:
    *   The Agent must be explicitly restricted from taking disruptive unauthorized actions during its free time.
    *   **Primary Restriction**: The Agent MUST NOT initiate contact with third parties (e.g., via WhatsApp, Email) without explicit prior user consent for that specific interaction.
    *   **Time Awareness**: The Agent MUST check the current time and effectively mute itself (using `[SILENT]`) during late night or usual sleeping hours to avoid waking the user up with non-critical notifications.
    *   **Permitted Actions**:
        *   Sending a message to the OWNER (`[SILENT]` suppression logic applies if no message is needed or if they are sleeping).
        *   Reviewing memories/journals.
        *   Performing background research (web searches) related to active interests.
        *   Checking the weather or schedule for the user to provide a timely update.

## Execution Flow

1.  `scheduler.js` system job `proactive_thought` fires hourly.
2.  Probabilistic check (e.g., 12.5% chance) passes.
3.  The `agent.processMessage` is invoked with the proactive prompt, setting `source: 'scheduler'`.
4.  The LLM evaluates its recent context (injected automatically by the agent's memory system).
5.  **Decision Branch**:
    *   **A**: The LLM decides nothing interesting needs doing. It outputs `[SILENT] No action needed.`
    *   **B**: The LLM decides to say something to Diego. It outputs `Hey Diego, I noticed X...`.
    *   **C**: The LLM decides to use a tool (e.g., search the web), and *then* outputs a message or `[SILENT]`.
6.  The smart notification logic in `scheduler.js` intercepts the response. If `[SILENT]` is present, it suppresses the notification. Otherwise, it sends the output to the `notification_channel` (via WhatsApp/Telegram).

## Security/Constraints
*   **Prompt Engineering is Key**: The prompt must strongly emphasize that while the agent is autonomous in this context, it is sandboxed socially. It must not use tools like `sendWhatsAppMessage` to anyone other than the defined owner during this loop.

## TDD/Testing Plan
*   Create `specs/014-proactive-agent.test.js` (or similar unit test).
*   Mock the scheduler and force the execution.
*   Verify the prompt is passed correctly.
*   Verify the probabilistic wrapper works.
