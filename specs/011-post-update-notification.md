# Spec 011: Post-Update Notification

## Objective
Ensure the Agent sends a message to the user after restarting if it was in the middle of a goal (e.g., self-improvement).

## Changes Required

### 1. Database (`apps/agent/src/db.js`)
- **Schema Change**: Add `metadata` column (JSON) to `goals` table.
- **Method Change**: `addGoal(description, metadata)`

### 2. Agent (`apps/agent/src/agent.js`)
- **New Tool**: `addGoal(description)`
    - Automatically captures the current `chatId` from the active message context and saves it in `metadata`.
- **Boot Logic (`start`)**:
    - Fetch pending goals.
    - If a goal has `metadata.chatId`, send a "I'm back!" message to that chat.

## Scenario: The Update Loop

1.  User: "Add a feature to read PDFs."
2.  Agent:
    - Calls `addGoal("Add PDF support", { chatId: "123" })`.
    - Calls `runShellCommand(...)` to change code.
    - Calls `Supervisor.commitAndPush(...)`.
3.  **System Restarts**.
4.  Agent Boots:
    - Finds goal "Add PDF support".
    - Reads `chatId: "123"`.
    - Sends to Interface: `target: "123", content: "I have restarted. I am now working on: Add PDF support."`

## Implementation Plan
1.  Update `AgentDB` to support metadata.
2.  Update `Agent` to expose `addGoal` tool and handle boot notification.
