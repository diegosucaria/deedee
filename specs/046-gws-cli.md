# Spec 046: Google Workspace CLI Integration via MCP

## 1. Overview
The goal is to replace DeeDee's custom, limited Calendar-only `gsuite-service.js` with the dynamically generated MCP Server from `@googleworkspace/cli` (`gws`). This will give DeeDee full read/write access to Gmail, Calendar, Drive, Docs, Sheets, and more.

## 2. Multi-Account Support
The core challenge is that the `gws mcp` server handles authentication via standard Google credentials files and typically operates under a single context. DeeDee needs to support multiple Google accounts (e.g., personal, work) simultaneously.

**Solution:**
1. **Multiple MCP Instances:** We will spawn a separate `gws mcp` instance for each configured Google account.
2. **MCP Namespacing:** We will update `mcp-manager.js` to support a `namespace` property in `mcp_config.json`.
   - If a namespace is provided (e.g., `personal_gws`), all tools from that server will be prefixed (e.g., `personal_gws_calendar_events_list`).
   - The MCP manager will intercept these prefixed requests, strip the prefix, and forward the correct original tool name to the appropriate `gws` subprocess.
3. **Agent UI Prompting:** We will update the Agent's system prompt (or skill) to understand that it has multiple GWS toolsets, distinguishing them by their namespace prefix to know which account it's operating on.

## 3. Authentication Strategy
The new `gws` CLI supports a `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` environment variable. To avoid the complexity of maintaining our own OAuth app and token refresh cycles, we will rely entirely on the native `gws` authentication flow.

**Solution:**
1. **Manual Login & Upload:** The user will authenticate locally using `gws auth login` and generate a `credentials.json` file.
2. **Web UI Upload:** The DeeDee Web Dashboard will feature a settings section where the user can upload this `credentials.json` file and assign it a label (e.g., "Personal", "Work").
3. **Secure Storage:** The backend will save the uploaded file to the persistent data directory (e.g., `/app/data/gws-credentials-personal.json`).
4. **Dynamic MCP Config Update:** The backend will then dynamically modify `mcp_config.json` to inject a `gws` MCP server block. It will map the `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` environment variable for that specific subprocess to the newly saved JSON file.

This approach is significantly cleaner and allows us to retire the old OAuth credentials and remove `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` from the `.env` file.

## 4. Implementation Steps
1. **Update `mcp-manager.js`:**
   - Add `namespace` support to `mcp_config.json`.
   - Update `getTools()` to dynamically prepend the prefix to the tool name and `this.toolMap`.
   - Update `callTool()` to map the prefixed name back to the original name before passing it to the MCP client.
2. **Update Frontend UI / Web Backend:**
   - Create a new UI component in `apps/web` (e.g., `GWS-Settings`) that allows uploading a JSON file with a custom label name.
   - Create a backend API route to receive the file, save it to `/app/data/gws-credentials-[label].json`, and update `mcp_config.json`.
   - Trigger `agent.mcp.init()` via the existing endpoints to reload the MCP servers dynamically.
3. **Cleanup (The Great Purge):**
   - Delete `apps/agent/src/executors/gsuite.js` and `apps/agent/src/services/gsuite-service.js`.
   - Remove hardcoded calendar tools from `tools-definition.js` and tests.
   - Remove obsolete `gsuite` dependencies from package.json (`googleapis`).
   - Globally install `@googleworkspace/cli` in the Dockerfile.
   - Remove `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` from `.env.example`, `.env` structure, and documentation.
