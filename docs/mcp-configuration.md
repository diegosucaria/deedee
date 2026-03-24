# MCP Server Configuration

Deedee uses the Model Context Protocol (MCP) to connect to external tools and services.

## Overview
- **Internal Tools**: Core tools (FileSystem, Git) run inside the Agent process.
- **External Tools**: Additional capabilities run as separate MCP Servers (e.g., Home Assistant).
- **Persistence**: Configuration is stored in `data/mcp_config.json` (inside the `agent-data` volume) and persists across updates.

## Management UI
The easiest way to manage servers is via the **Brain > Tools & MCP** page in the web dashboard.

### Adding a Server
1.  Go to `Settings` (GEAR ICON) -> `Tools & MCP`.
2.  Click **"Connect New Server"**.
3.  Enter the Name (e.g., `home-assistant`).
4.  Enter the URL (e.g., `http://192.168.1.x:8123/sse`) or Command details.
5.  (Optional) Enter an Auth Token.

The Agent will automatically reload and connect to the new server.

## Google Workspace Integration

DeeDee uses the [`@googleworkspace/cli`](https://github.com/googleworkspace/cli) MCP server (pinned to v0.6.3) to provide full access to Gmail, Calendar, Drive, Docs, Sheets, and more. Note: v0.7.0+ removed multi-account support and v0.8.0 removed the `mcp` command entirely.

### Authentication

Two authentication methods are available:

**Option A: One-Click OAuth (Recommended)**
1. Create a **Web application** OAuth client in [Google Cloud Console](https://console.cloud.google.com/apis/credentials).
2. Set the redirect URI to: `https://<your-deedee-domain>/api/auth/google/callback`
3. Go to **Settings > Interfaces > Google Workspace** and upload the `client_secret.json` in the OAuth Client section.
4. Click **Connect Workspace Account**, enter a label and email, then click **Sign in with Google**.
5. The UI automatically validates tokens on page load. If a token has expired, the account card shows an **Auth Expired** badge and a prominent **Re-connect** button to re-authenticate with one click.

**Option B: Manual Upload (Fallback)**
1. Authenticate locally: `gws auth login`
2. Export credentials: `gws auth export --unmasked > credentials.json`
3. Upload via **Settings > Interfaces > Google Workspace > Upload manually**.

### Multi-Account Support

Multiple Google accounts are supported simultaneously. Each account gets a namespace prefix (e.g., `work`, `personal`), and all MCP tools from that account are prefixed accordingly (e.g., `work_calendar_events_list`).

### Calendar Filtering

By default, the agent only has access to the **primary calendar** for each account. This prevents subagents from wasting API calls iterating through irrelevant calendars (holidays, shared calendars, etc.).

To configure which calendars the agent can see:
1. Go to **Settings > Interfaces > Google Workspace**
2. On a connected account, click **Calendar Access**
3. Select the calendars the agent should have access to
4. Click **Save**

Calendar filters are stored per-account in the `agent_settings` database (key: `gws_calendar_filter:{label}`). When no filter is configured, only the primary calendar is exposed.

### Credentials Storage

- OAuth client config: `/app/data/gws-oauth-client.json`
- Per-account credentials: `/app/data/gws-credentials-{label}.json`
- MCP config entries: `data/mcp_config.json` (auto-managed)
- Calendar filter config: `agent_settings` DB table (key: `gws_calendar_filter:{label}`)

## Manual Configuration (Advanced)
You can still manually edit `mcp_config.json` if you have shell access, but the UI is recommended.

### Default Servers
The system comes with default configurations (Home Assistant, Plex, Node-RED) that are automatically merged into your configuration on startup.
