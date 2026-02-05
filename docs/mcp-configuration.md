# MCP Server Configuration

Deedee uses the Model Context Protocol (MCP) to connect to external tools and services.

## Overview
- **Internal Tools**: Core tools (FileSystem, Git) run inside the Agent process.
- **External Tools**: Additional capabilities run as separate MCP Servers (e.g., Mac Bridge, Home Assistant).
- **Persistence**: Configuration is stored in `data/mcp_config.json` (inside the `agent-data` volume) and persists across updates.

## Management UI
The easiest way to manage servers is via the **Brain > Tools & MCP** page in the web dashboard.

### Adding a Server
1.  Go to `Settings` (GEAR ICON) -> `Tools & MCP`.
2.  Click **"Connect New Server"**.
3.  Enter the Name (e.g., `mac-bridge`).
4.  Enter the URL (e.g., `http://100.x.y.z:3000/sse`) or Command details.
5.  (Optional) Enter an Auth Token.

The Agent will automatically reload and connect to the new server.

## Mac Bridge Integration
To control your Mac (Apps, Mouse, Keyboard) from Deedee:

1.  **Run Mac Bridge**: Follow instructions in `apps/mac-bridge/README.md`.
2.  **Get Tailscale IP**: Ensure both Pi and Mac are on Tailscale.
3.  **Add to Deedee**:
    - **Name**: `mac-bridge`
    - **URL**: `http://<MAC_TAILSCALE_IP>:3000/sse`
    - **Token**: The one you set in `.env` (`BRIDGE_TOKEN`).

## Manual Configuration (Advanced)
You can still manually edit `mcp_config.json` if you have shell access, but the UI is recommended.

### Default Servers
The system comes with default configurations (Home Assistant, Plex, Node-RED) that are automatically merged into your configuration on startup.
