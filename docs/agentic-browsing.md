# Agentic Browsing (Moltbot Features)

DeeDee now includes robust browser automation capabilities. This allows the agent to "see" and "act" on the web.

## Architecture
-   **Service**: `@deedee/mcp-server-browser`
-   **Engine**: Playwright (System Chromium on Raspberry Pi)
-   **Persistence**: Uses a persistent profile in `data/browser_profile`. Cookies and logins survive restarts.

## Tools

### Navigation & Vision
-   `browser_navigate(url, waitUntil?, timeout?)`: Visit a website. Supports `networkidle` for SPAs.
-   `browser_screenshot(fullPage)`: Take a photo of the page.
-   `browser_click_vision(description)`: Click using standard visual description.
-   `browser_click_vision_annotated(description)`: **(Recommended)** Click using "Set-of-Mark" vision. Injects numeric labels into the page and asks the model to pick the number. 100% precision.

### Inspection
-   `browser_extract_text()`: Read page (Markdown). Good for articles.
-   `browser_get_accessibility_tree()`: **(Recommended for SPAs)** Read semantic structure (Buttons, Inputs, Roles). Good for apps like Gmail/Spotify.

### Interaction
-   `browser_click(selector)`: Click buttons or links (CSS).
-   `browser_type(selector, text)`: Type standard text.
-   `browser_run_script(script)`: Execute custom JavaScript.

### Identity & Secrets
To avoid leaking passwords in logs or context, utilize the **Secret Store**:
1.  **List Secrets**: `browser_list_secrets()` shows available keys (e.g. `AMAZON_PASSWORD`).
2.  **Use Secrets**: `browser_fill_secret(selector, 'AMAZON_PASSWORD')` types the value securely.

### Security Architecture
-   **Agent Access**: Read-Only via internal file access.
-   **Management**: Secrets are managed via the Web UI (Brain > Memory > Secrets).
-   **Isolation**: The Web UI uses a secured proxy (`/v1/browser-secrets` -> Agent `/internal/browser-secrets`) to avoid direct filesystem access or unauthenticated internal calls.


## Configuration (Env Vars)
-   `BROWSER_HEADLESS`: `true` (default) or `false`.
-   `BROWSER_USER_DATA_DIR`: Path to profile.
-   `BROWSER_EXECUTABLE_PATH`: Path to system chromium (Automatic on Docker).

