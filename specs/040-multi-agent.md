# Spec 040: Multi-Agent / Sub-Agent System

## Goal
Enable DeeDee to spawn sub-agents for parallel, specialized tasks. A sub-agent is an isolated agent session that runs a specific task and reports back to the parent. This enables complex workflows like research, parallel tool execution, and divide-and-conquer strategies.

## Background
Inspired by OpenClaw's `sessions_spawn` system which provides:
- Isolated agent sessions with independent context/history.
- Reply-back mechanism (sub-agent → parent).
- Depth limits to prevent infinite spawning.
- Per-session model selection.

DeeDee currently has `spawnAgent` in the roadmap (`tools-master-plan.md`) but nothing implemented.

## Architecture

### Core Concept
A sub-agent is a **new `Agent.processMessage()` call** running in parallel with its own:
- **Isolated chat history** (separate `chatId`).
- **Focused system prompt** (task-specific instructions appended).
- **Time budget** (max execution time).
- **Tool subset** (optionally restricted tools).

The parent agent spawns sub-agents via the `spawnAgent` tool, and sub-agents report results back.

### Data Model

```sql
-- New table in agent.db
CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  parent_chat_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT DEFAULT 'running',  -- running, completed, failed, timeout
  model TEXT,                      -- optional model override
  result TEXT,                     -- final output
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (parent_chat_id) REFERENCES chat_sessions(id)
);
```

### Execution Model

```
Parent Agent (chatId: abc-123)
│
├─ spawnAgent("Research flight prices to Rome")
│   └─ Sub-Agent (chatId: sub-xxx-001)
│       ├─ Uses browser_navigate, extract_text
│       ├─ Runs for up to 5 minutes
│       └─ Returns: { result: "Best price: $450 on..." }
│
├─ spawnAgent("Check my calendar for next week")
│   └─ Sub-Agent (chatId: sub-xxx-002)
│       ├─ Uses listEvents
│       └─ Returns: { result: "You have 3 meetings..." }
│
└─ Waits for both → Combines results → Replies to user
```

## Features & Tools

### 1. `spawnAgent` Tool
```javascript
{
  name: "spawnAgent",
  description: "Spawn a sub-agent to perform a specific task in parallel. The sub-agent has its own context and can use tools independently. Use this for tasks that can run independently or in parallel. Returns a task ID that can be checked with getAgentResult.",
  parameters: {
    type: "OBJECT",
    properties: {
      task: { type: "STRING", description: "Clear, specific task description for the sub-agent." },
      model: { type: "STRING", description: "Optional model override (e.g., 'FLASH', 'PRO'). Default: FLASH." },
      tools: {
        type: "ARRAY",
        items: { type: "STRING" },
        description: "Optional list of allowed tools. Default: all tools available."
      },
      timeoutMinutes: { type: "NUMBER", description: "Max execution time in minutes (default: 3, max: 10)." },
      waitForResult: { type: "BOOLEAN", description: "If true, block until the sub-agent completes and return the result directly. Default: false." }
    },
    required: ["task"]
  }
}
```

### 2. `getAgentResult` Tool
```javascript
{
  name: "getAgentResult",
  description: "Check the status/result of a spawned sub-agent.",
  parameters: {
    type: "OBJECT",
    properties: {
      taskId: { type: "STRING", description: "The task ID returned by spawnAgent." }
    },
    required: ["taskId"]
  }
}
```

### 3. `listAgentTasks` Tool
```javascript
{
  name: "listAgentTasks",
  description: "List all active and recent sub-agent tasks for the current session.",
  parameters: {
    type: "OBJECT",
    properties: {},
    required: []
  }
}
```

## Implementation Plan

### Phase 1: Core Sub-Agent Runner

#### `apps/agent/src/services/subagent-service.js` [NEW]
```javascript
class SubAgentService {
  constructor(agent) {
    this.agent = agent;
    this.running = new Map(); // taskId → { promise, abortController }
  }

  async spawn({ task, model, tools, timeoutMinutes, parentChatId }) {
    const taskId = `sub-${crypto.randomUUID().slice(0, 8)}`;
    const chatId = `subagent-${taskId}`;
    
    // Create isolated session
    this.agent.db.createSession({ id: chatId, title: `Sub: ${task.slice(0, 50)}` });
    
    // Record in DB
    this.agent.db.run(`INSERT INTO subagents ...`, { id: taskId, ... });
    
    // Build sub-agent message
    const message = {
      content: task,
      chatId,
      source: 'subagent',
      metadata: {
        parentChatId,
        taskId,
        isSubAgent: true,
        allowedTools: tools || null,
        modelOverride: model || 'FLASH',
      }
    };
    
    // Run with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (timeoutMinutes || 3) * 60000);
    
    const promise = this.agent.processMessage(message, async (reply) => {
      // Collect replies silently (don't send to user)
    }).finally(() => clearTimeout(timeout));
    
    this.running.set(taskId, { promise, controller });
    return taskId;
  }

  async getResult(taskId) { ... }
  listTasks(parentChatId) { ... }
}
```

#### Key Design Decisions

1. **Isolation via `chatId`**: Each sub-agent gets a unique `chatId` prefix (`subagent-*`). History is separate. The parent never sees sub-agent tool calls in its context.

2. **Model selection**: Sub-agents default to `FLASH` for speed/cost. Parent can override to `PRO` for complex reasoning tasks.

3. **Tool restriction**: Optional. If `tools` array is provided, the sub-agent's `_executeTool` filters against it. By default, all tools are available.

4. **Depth limit**: Sub-agents cannot spawn other sub-agents (depth = 1). This prevents runaway recursion. Enforced by checking `message.metadata.isSubAgent` in `spawnAgent` handler.

5. **Timeout**: Hard timeout with `AbortController`. Default 3 minutes, max 10. On timeout, result is saved as `{ status: 'timeout', partial: lastReply }`.

6. **Blocking vs Async**: 
   - `waitForResult: true` → blocks the parent tool call until sub-agent completes (simpler for sequential tasks).
   - `waitForResult: false` → returns `taskId` immediately, parent checks later with `getAgentResult` (better for parallel).

### Phase 2: Agent Integration

1. **Modify `agent.js`**:
   - Initialize `SubAgentService` in `Agent.start()`.
   - In `processMessage()`, detect `isSubAgent` flag and:
     - Append task-specific system prompt: `"You are a focused sub-agent. Complete the following task and provide a clear, concise result: {task}"`.
     - Force model to `metadata.modelOverride`.
     - Apply tool restrictions if specified.
   - In `_executeTool()`, add depth guard for `spawnAgent`.

2. **Add tools to `tools-definition.js`**: `spawnAgent`, `getAgentResult`, `listAgentTasks`.

3. **Create `apps/agent/src/executors/subagent.js`**: `SubAgentExecutor` handling all three tools.

4. **Register in `tool-executor.js`**.

### Phase 3: Progress & Cleanup

1. **Progress reporting**: Sub-agent status visible in Web UI (small indicator when sub-agents are running).
2. **Cleanup**: Auto-archive sub-agent sessions after 24h. Don't show in main session list.
3. **Cost tracking**: Sub-agent costs attributed to parent session.

### Phase 4: Smart Patterns (Future)

1. **Parallel research**: "Compare prices for X across 3 sites" → spawn 3 sub-agents.
2. **Code review**: Spawn a PRO sub-agent to review code while the parent continues.
3. **Long-running tasks**: Spawn a sub-agent for a task that takes minutes while the parent stays responsive.

## Guards & Safety

| Guard | Implementation |
|---|---|
| Max depth | Sub-agents cannot spawn sub-agents (depth=1) |
| Max concurrent | 3 sub-agents per parent session |
| Max timeout | 10 minutes per sub-agent |
| Auto-cleanup | Archive sub-agent sessions after 24h |
| Cost cap | Sub-agents use FLASH by default |
| Tool restriction | Optional allowlist per sub-agent |

## Files Changed

| File | Action | Description |
|---|---|---|
| `apps/agent/src/services/subagent-service.js` | NEW | Core sub-agent runner |
| `apps/agent/src/executors/subagent.js` | NEW | SubAgentExecutor |
| `apps/agent/src/agent.js` | MODIFY | Init SubAgentService, depth guard, sub-agent mode |
| `apps/agent/src/tools-definition.js` | MODIFY | Add 3 new tools |
| `apps/agent/src/tool-executor.js` | MODIFY | Register SubAgentExecutor |
| `apps/agent/src/db.js` | MODIFY | Add `subagents` table, migration |

## Testing
- **Unit**: Test spawn, timeout, depth guard, tool restriction.
- **Integration**: Spawn sub-agent that uses `searchMemory` → verify result returned.
- **Manual**: "Research X using two different approaches" → verify parallel execution.
