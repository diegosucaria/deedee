# How to Configure MCP Servers

Deedee uses the Model Context Protocol (MCP) to connect to external tools and services.

## Overview
- **Internal Tools**: Core tools like File System and Git run inside the Agent process (`apps/agent`).
- **External Tools**: Additional capabilities run as separate MCP Servers, managed by the `MCPManager`.

## Configuration
The agent looks for a configuration file at `apps/agent/mcp_config.json`.

### Structure
```json
{
  "server-name": {
    "command": "executable",
    "args": ["arg1", "arg2"],
    "env": {
      "VAR_NAME": "value",
      "SECRET": "${ENV_VAR_NAME}" 
    },
    "disabled": false
  }
}
```

- **`command`**: The executable to run (e.g., `npx`, `python`).
- **`args`**: Array of arguments.
- **`env`**: Environment variables to pass to the server. You can reference system environment variables using `${VAR_NAME}` syntax.
- **`disabled`**: Set to `true` to disable the server.

## Examples

### 1. Home Assistant
To enable Home Assistant integration:

3.  **Edit `apps/agent/mcp_config.json`**:
    ```json
    {
      "homeassistant": {
        "command": "uvx",
        "args": ["ha-mcp"],
        "env": {
          "HOMEASSISTANT_URL": "${HA_URL}",
          "HOMEASSISTANT_TOKEN": "${HA_TOKEN}"
        },
        "disabled": false
      }
    }
    ```
    *Note*: The `ha-mcp` server acts as a standard API client and does not require server-side integration in Home Assistant. Ensure `HA_URL` and `HA_TOKEN` are set in your environment.

### 2. PostgreSQL
```json
{
  "postgres": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:password@localhost/db"],
    "disabled": false
  }
}
```

## Adding New Servers
1.  Find an MCP Server (e.g., on NPM or GitHub).
2.  Add its config to `mcp_config.json`.
3.  Restart the Agent (`docker-compose restart agent` or let Supervisor handle it if updated via git).
