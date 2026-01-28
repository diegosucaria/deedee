# Agentic Browsing (Moltbot Features)

DeeDee now includes robust browser automation capabilities. This allows the agent to "see" and "act" on the web.

## Architecture
-   **Service**: `@deedee/mcp-server-browser`
-   **Engine**: Playwright (System Chromium on Raspberry Pi)
-   **Persistence**: Uses a persistent profile in `data/browser_profile`. Cookies and logins survive restarts.

## Tools

### Navigation & Vision
-   `browser_navigate(url)`: Visit a website.
-   `browser_screenshot(fullPage)`: Take a photo of the page.
-   `browser_extract_text(selector?)`: Read the page content.

### Interaction
-   `browser_click(selector)`: Click buttons or links.
-   `browser_type(selector, text)`: Type standard text.
-   `browser_run_script(script)`: Execute custom JavaScript.

### Identity & Secrets
To avoid leaking passwords in logs or context, utilize the **Secret Store**:
1.  **List Secrets**: `browser_list_secrets()` shows available keys (e.g. `AMAZON_PASSWORD`).
2.  **Use Secrets**: `browser_fill_secret(selector, 'AMAZON_PASSWORD')` types the value securely.

## Configuration (Env Vars)
-   `BROWSER_HEADLESS`: `true` (default) or `false`.
-   `BROWSER_USER_DATA_DIR`: Path to profile.
-   `BROWSER_EXECUTABLE_PATH`: Path to system chromium (Automatic on Docker).

