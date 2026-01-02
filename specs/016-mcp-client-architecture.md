# Spec 016: Agent as MCP Client

## Goal
Transform Deedee from using hardcoded internal tools to being a fully compliant **Model Context Protocol (MCP) Client**. This allows Deedee to connect to any standard MCP Server (Home Assistant, Postgres, GitHub, etc.) without writing custom integration code.

## Architecture Changes

### 1. New Dependency
- Install `@modelcontextprotocol/sdk` in `apps/agent`.

### 2. MCP Manager (`src/mcp-manager.js`)
- A new class responsible for:
    - Reading `mcp_config.json`.
    - Spawning MCP Servers (Stdio transport).
    - Managing `Client` connections.
    - Aggregating `list_tools` from all servers.
    - Forwarding `call_tool` requests to the correct server.

### 3. Configuration (`mcp_config.json`)
Allows easy addition of servers.
```json
{
  "homeassistant": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-homeassistant"],
    "env": {
      "HA_URL": "...",
      "HA_TOKEN": "..."
    }
  }
}
```

### 4. Hybrid Tool System
We will maintain a **Hybrid** approach:
- **System Tools** (Internal): `pullLatestChanges`, `commitAndPush`, `rollback`. Kept internal for safety and privileged access.
- **MCP Tools** (External): Home Assistant, Filesystem (migrated?), GSuite (migrated?).

### 5. Docker Updates
- The Agent container needs to support running these servers.
- **Requirement**: We might need to install `python3` if we want Python-based MCP servers. For now, we focus on Node.js servers.

## Implementation Steps

1.  **Install SDK**: Add dependency.
2.  **Create Manager**: Implement `MCPManager` class.
3.  **Refactor Agent**:
    - Initialize `MCPManager` on startup.
    - Merge `MCPManager.getTools()` with `internalTools`.
    - Update `onMessage` execution loop to route tool calls:
        - If internal -> Call internal method.
        - If external -> `MCPManager.callTool(...)`.
4.  **Test**: Verify with a simple implementation (e.g., Home Assistant or existing Local tool migrated).

## Risks
- **IO Overhead**: Spawning multiple processes might strain the RPi memory.
- **Complexity**: Debugging stdio communication errors can be tricky.
