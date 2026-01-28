# Spec 038: Agentic Browsing (Moltbot Features)

## Goal
Enable DeeDee to browse the web autonomously using a "headless" browser that actually has eyes (screenshots) and hands (clicks/typing). This brings "Computer Use" capabilities to the agent.

## Background
Inspired by Moltbot (Clawdbot), we want to give the agent the ability to perform tasks like:
- "Check the price of X on Amazon"
- "Log in to my utility provider and tell me the bill amount"
- "Search Google (natively) and extract results"

## Architecture: The `browser` MCP Server

We will build this as a standalone **Model Context Protocol (MCP)** server: `packages/mcp-servers/browser`.

### Why standalone?
1.  **Isolation**: Browser automation (Playwright) is resource-intensive and prone to crashes/hangs. If it crashes, it shouldn't take down the main Agent process.
2.  **Security**: The browser process can be sandboxed or run with different privileges.

### Technology Stack
-   **Library**: Playwright (Best-in-class for automation, robust selectors).
-   **Browser**: Chromium (bundled).

## Features & Tools

The MCP Server will expose the following tools to the Agent:

### 1. Navigation & Inspection
-   `browser_navigate(url)`: Go to a URL.
-   `browser_screenshot(fullPage: boolean)`: Returns a base64 image of the current viewport. **CRITICAL**: The Agent is multimodal; giving it "sight" is better than just extracting text.
-   `browser_extract_text()`: Returns the page content converted to Markdown (using `Turndown` or similar).

### 2. Interaction
-   `browser_click(selector)`: Click an element. Supports CSS and XPath.
-   `browser_type(selector, text)`: Type text into a field.
-   `browser_press(key)`: Press a key (e.g. 'Enter').

### 3. Identity & Secrets (The "Secret Store")
-   `browser_list_secrets()`: Request a list of *names* of available secrets (e.g. `["AMAZON_PASSWORD", "GITHUB_TOKEN"]`).
-   `browser_fill_secret(selector, secretKey)`:
    -   The Agent calls this with a key from the list.
    -   The MCP Server securely types the value.

### 4. State & Persistence
-   **Persistent Profile**: The browser uses a `userDataDir` on disk.
    -   Cookies, LocalStorage, and Logins are saved automatically.
    -   Survives restarts (e.g. if the Agent updates).
    -   **Always On**: No timeouts.

### 5. Authentication Strategy
-   **Secrets**: Usernames can also be stored as secrets (e.g. `AMAZON_USERNAME`) if desired, or passed as plain text.
-   **2FA / OTP**:
    -   Agent Logic: "I see a 2FA field." -> Screenshot -> Ask User "Please send the code."
    -   Action: User replies with code -> Agent uses `browser_type`.

### 6. Javascript Execution
-   `browser_run_script(script)`: Execute arbitrary JS for complex interactions.

## Security Constraints
1.  **Headless by Default**: Run headless to avoid popping up windows on the host server.
2.  **No Downloads**: Block file downloads to prevent disk filling or malware (unless specifically enabled later).

## Implementation Steps
1.  Initialize `packages/mcp-servers/browser`.
2.  Install `playwright`, `turndown`, `@modelcontextprotocol/sdk`.
3.  Implement Server Class with persistent `browser` instance.
4.  Add tools.
5.  Register in `apps/agent/src/mcp-manager.js`.
