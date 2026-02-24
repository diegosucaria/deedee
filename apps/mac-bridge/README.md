# Mac Bridge Setup

This application runs on your macOS machine to give DeeDee remote control capabilities.

## Prerequisites
1.  **Node.js**: Installed on your Mac.
2.  **Chrome**: Must be running with debugging enabled:
    ```bash
    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
    ```
3.  **Tailscale**:
    *   Installed on your Mac.
    *   Logged in to the same Tailnet as your RPi (DeeDee).
4.  **Permissions**:
    *   When you first run this, macOS will prompt to allow `node` (or `zsh`) to control your computer (Accessibility/Automation). **You MUST approve these.**

## Quick Install (User Friendly)
1.  Double-click `install.command` in this folder.
    *   It will check for Node.js, install dependencies (if needed).
    *   **It will automatically generate a secure token** and save it to `.env`.
    *   It will show you the Token at the end—**Copy this token** to use in DeeDee.

## Uninstall
1.  Double-click `uninstall.command` to stop the service and remove it from startup.

## Manual Installation
1.  Navigate to this folder:
    ```bash
    cd apps/mac-bridge
    ```
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Create `.env` (The install script does this automatically):
    ```bash
    echo "BRIDGE_TOKEN=$(uuidgen)" > .env
    ```

## Running
### Background Service (Recommended)
Use the `install.command` script to set up the auto-start service.

### Manual Start
```bash
npm start
```
The server will start on port 3000.

## Connecting DeeDee
1.  On your Mac, get your Tailscale IP (e.g., `100.x.y.z`).
2.  In DeeDee's `mcp_config.json`, add:
    ```json
    "mac-bridge": {
      "transport": "sse",
      "url": "http://100.x.y.z:3000/sse",
      "env": {
        "HA_TOKEN": "super-secret-token-change-me" 
      },
      "disabled": false
    }
    ```
    *(Note: We abuse `HA_TOKEN` field for the Bearer token currently in `mcp-manager.js`'s generic SSE logic, or specific env var mapping.)*

    **Better Config:**
    DEEDEE `mcp-manager` uses `HA_TOKEN` for the Authorization header in SSE Transport generically? Let's check `mcp-manager.js`.
    Yes, deeply nested logic:
    ```javascript
    if (env.HA_TOKEN) { ... headers: { "Authorization": `Bearer ${env.HA_TOKEN}` } ... }
    ```
    So defining `HA_TOKEN` in the `env` block of `mcp_config.json` will inject the Authorization header correctly.
