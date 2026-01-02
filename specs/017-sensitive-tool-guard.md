# Spec 017: Sensitive Tool Guard (Confirmation Middleware)

## 1. Objective
Implement a safety mechanism that intercepts **specific** high-risk tool calls and requires explicit user confirmation before execution, while maintaining the "YOLO" autonomous nature for standard operations.

## 2. Philosophy: "YOLO but don't delete my house"
- **Allowed (Autonomous)**:
    - Modifying source code (`writeFile`, `commitAndPush`).
    - Standard Home Control (`light.turn_off`, `switch.toggle`).
    - Shell commands (mostly).
- **Guarded (Requires Confirmation)**:
    - **Critical HA Actions**: Disable automations, Scripts that delete data, Security disarm.
    - **Destructive Shell**: `rm -rf /` (if we can detect it), formatting drives.
    - **Financial/Identity**: Sending emails to "everyone", deleting Calendar events.

## 3. Architecture

### A. `ConfirmationManager` Class
- **State**: Needs to store `pendingAction` in memory (or DB for persistence across restarts, but memory is simpler for flow).
- **Methods**:
    - `check(toolName, args) -> { allowed: boolean, reason: string }`
    - `registerPending(toolName, args, originalMsgMetadata)`
    - `confirmLast()`
    - `rejectLast()`

### B. Guard Rules (Configuration)
We define rules in a clean config structure:

```javascript
const SENSITIVE_RULES = [
    // Rule: Warning on Automation Disabling
    {
        tool: 'homeassistant', // or generic MCP name
        condition: (args) => args.domain === 'automation' && args.service === 'turn_off',
        message: '⚠️ Disabling an automation requires confirmation.'
    },
    // Rule: Protect Critical Files (Example)
    {
        tool: 'writeFile',
        condition: (args) => args.path.includes('.env'),
        message: '⚠️ Modifying .env file requires confirmation.'
    }
];
```

### C. Interaction Flow

1.  **Agent Logic** calls `_executeTool(name, args)`.
2.  **Guard Check**: `ConfirmationManager.check(name, args)`.
3.  **If Allowed**: Execute immediately.
4.  **If Blocked**:
    - Save action to `ConfirmationManager`.
    - Return a special "Tool Result" to the model:
        `{ info: "Action PAUSED. Use requires confirmation. I have sent a request to the user." }`
    - Send message to User:
        `🛑 **CONFIRM**: automation.turn_off entity_id=automation.security \nReply '/confirm' or '/cancel'`
5.  **User Replies `/confirm`**:
    - `CommandHandler` detects trigger.
    - `ConfirmationManager` executes the stored action.
    - Sends result back to User (as a new notification).
    - *Note*: This breaks the original "Agent Loop" context because the model has already "finished" its turn (it got the "PAUSED" info).
    - *Better handling*: The Agent loop should ideally PAUSE? No, HTTP is stateless. The Agent must *stop*.
    - When user confirms, we essentially start a *new* turn where we say "User confirmed. Result: {result}".

## 4. Implementation Steps
1.  Create `apps/agent/src/confirmation-manager.js`.
2.  Integrate into `agent.js` loop.
3.  Add `/confirm` and `/cancel` to `command-handler.js`.
4.  (Optional) Add rules config.

## 5. Test Plan
- Test A: Normal tool (writeFile) -> Runs immediately.
- Test B: Sensitive tool (mocked) -> Stops, asks confirmation.
- Test C: /confirm -> Executes tool.
