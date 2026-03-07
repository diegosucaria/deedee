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
The new `gws` CLI supports a `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` environment variable and accepts standard `authorized_user` credentials JSON (`{ type, client_id, client_secret, refresh_token }`).

**Solution (Two Methods):**

### Method A: One-Click OAuth (Primary)
For environments where terminal access is inconvenient (e.g., RPi deployed via Balena):
1. **One-time setup:** User creates a **Web application** OAuth client in Google Cloud Console, sets redirect URI to `https://<deedee-domain>/api/auth/google/callback`, and uploads the `client_secret.json` to DeeDee.
2. **Daily re-auth:** User clicks "Re-auth" on the account card → Google consent → DeeDee exchanges the auth code for tokens server-side → writes the credentials file → reloads MCP. No terminal needed.
3. **OAuth flow:** Next.js callback route (`/api/auth/google/callback`) receives Google's redirect, forwards the code to the Agent via the authenticated API (`/v1/settings/gws/oauth/exchange`), which exchanges it at `https://oauth2.googleapis.com/token` and writes the GWS CLI credentials file.
4. **Security:** OAuth client credentials stored server-side only. All API routes behind Bearer token auth. Callback route behind IAP proxy.

### Method B: Manual Upload (Fallback)
1. **Manual Login & Upload:** The user authenticates locally using `gws auth login` and exports with `gws auth export --unmasked > credentials.json`.
2. **Web UI Upload:** The DeeDee Web Dashboard settings section allows uploading this file with a label (e.g., "Personal", "Work").
3. **Secure Storage:** The backend saves the uploaded file to the persistent data directory (e.g., `/app/data/gws-credentials-personal.json`).
4. **Dynamic MCP Config Update:** The backend dynamically modifies `mcp_config.json` to inject a `gws` MCP server block with the `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` and `GOOGLE_WORKSPACE_CLI_ACCOUNT` environment variables.

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
