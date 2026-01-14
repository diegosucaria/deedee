# Feature Spec: Node-RED Integration

## 1. Objective
Allow the Agent to list, read, and modify Node-RED flows to enable self-improvement and automation creation.

## 2. Architecture
- **Component**: New MCP Server `@deedee/node-red-mcp`.
- **Protocol**: Node-RED Admin API (HTTP/JSON).
- **Transport**: Standard MCP via `stdio` (Agent runs `node packages/node-red-mcp/index.js`).

## 3. Configuration
The agent (and MCP server) requires connection details.
- `NODE_RED_URL`: Base URL (User confirmed: `http://homeassistant.local:1880`).
- `NODE_RED_USERNAME`: Basic Auth Username.
- `NODE_RED_PASSWORD`: Basic Auth Password.

## 3.1 Usage Constraints (CRITICAL)
- **Scope**: Node-RED is considered a subsystem of Home Assistant.
- **Limitation**: The Agent MUST NOT use Node-RED for general purpose computing, scraping, or external API tasks unrelated to HA. It is strictly for creating HA automations.

## 4. Tools Definition

### `node_red_list_flows`
- **Description**: List all active flows (tabs).
- **Output**: JSON array of flow metadata (id, label, disabled).

### `node_red_get_flow`
- **Description**: Get the full JSON definition of a specific flow (tab) and its nodes.
- **Args**: `flowId` (string).
- **Output**: JSON array of nodes.

### `node_red_update_flow`
- **Description**: Update the configuration of a specific flow.
- **Args**:
    - `flowId` (string): The ID of the tab to update.
    - `nodes` (JSON string/object): The new list of nodes for this flow.
- **Behavior**: Replaces the nodes for that flow.

### `node_red_deploy`
- **Description**: Trigger a deployment of changes.
- **Args**: `type` ("full", "flows", "nodes"). Default "flows".

## 5. Security Implications
- **High Risk**: Node-RED has full access to HA and potentially the host system.
- **Guardrails**:
    - The Agent is "YOLO" mode but we should backup flows before modifying? (Future scope).
    - For now, direct modification is allowed.

## 6. Implementation Steps
1. Create `packages/node-red-mcp`.
2. Implement `NodeREDClient` class to talk to Admin API.
3. Implement `MCPServer` using `@modelcontextprotocol/sdk`.
4. Register in `apps/agent/mcp_config.json`.
