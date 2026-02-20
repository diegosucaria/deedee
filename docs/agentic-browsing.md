# Agentic Browsing (Browser V2)

DeeDee includes robust browser automation capabilities powered by Playwright. The V2 implementation relies on a highly reliable semantic approach using ARIA snapshots and ref-based interactions.

## Architecture
-   **Service**: `@deedee/mcp-server-browser`
-   **Engine**: Playwright (System Chromium on Raspberry Pi)
-   **Persistence**: Uses a persistent profile in `browser-profile`. Cookies and logins survive restarts.
-   **Modularity**: The server is split into `state.js`, `snapshot.js`, `interactions.js`, `wait.js`, `vision.js`, and `screencast.js`.

## Primary Workflow: Ref-Based Interactions

Instead of brittle CSS selectors, the agent uses **refs** (e.g., `e1`, `e2`) mapped to interactive elements on the page.

1. **Navigate**: `browser_navigate(url)` auto-returns a compact ARIA snapshot with refs.
2. **Snapshot**: `browser_snapshot()` can be called anytime to get the current page structure and available refs.
3. **Interact**: Use tools like `browser_click(ref)`, `browser_type(ref, text)`, `browser_fill_form`, etc., using the refs from the snapshot.

## Tools Overview

### Navigation & Inspection
-   `browser_navigate`: Visit a website and get a snapshot.
-   `browser_snapshot`: Get the page's ARIA accessibility tree with refs. Supports interacting inside iframes via `frameSelector`.
-   `browser_screenshot`: Take a screenshot. Supports `--withLabels` to draw bounding boxes with ref labels without mutating the DOM.
-   `browser_extract_text`: Extract visible text content as Markdown.

### Interaction (Ref-Based)
All interaction tools support optional `timeoutMs` to handle slow SPAs, and `frameSelector` to interact with cross-origin iframes.
-   `browser_click`: Click an element by ref.
-   `browser_type`: Type text into an element by ref.
-   `browser_fill_form`: Batch-fill multiple inputs quickly.
-   `browser_select`: Select dropdown options.
-   `browser_hover`: Hover over an element.
-   `browser_scroll`: Scroll to an element or directionally.
-   `browser_press_key`: Press keyboard keys.
-   `browser_drag`: Drag an element to another by their refs.

### Waiting & Advanced
-   `browser_wait`: Wait for text to appear/disappear, URLs to match, load states, or fixed time.
-   `browser_evaluate`: Run arbitrary Javascript on the page.

### Identity & Secrets
To avoid leaking passwords in context, utilize the Secret Store:
1.  **List Secrets**: `browser_list_secrets()` shows available keys (filters for `BROWSER_SECRET_` env vars and `browser-secrets.json`).
2.  **Use Secrets**: `browser_fill_secret(ref, secretKey)` types the value securely directly into the Playwright frame.

## Resilience & Stability (V2.1)
-   **AI-Friendly Errors**: If Playwright fails due to an element being intercepted (e.g., covered by a modal) or timing out, the MCP server intercepts the crash and returns an actionable error message to the agent instead of throwing an unhandled exception.
-   **Snapshot Truncation**: To protect LLM memory limits, `browser_snapshot` output is capped at 20,000 characters.
-   **Iframe Tunneling**: Elements inside cross-origin iframes (like Captchas or Stripe checkouts) can be accessed seamlessly by passing `frameSelector` to snapshot and interaction tools.

## Configuration (Env Vars)
-   `BROWSER_HEADLESS`: `true` (default) or `false`.
-   `BROWSER_USER_DATA_DIR`: Path to profile.
-   `BROWSER_EXECUTABLE_PATH`: Path to custom chromium executable (Automatic on Docker).
-   `INTERFACES_URL` / `DEEDEE_API_TOKEN`: Used for the CDP live screencast relay.
