# Agentic Browsing (Browser V2.1)

DeeDee includes robust browser automation capabilities powered by Playwright. The V2.1 implementation relies on a highly reliable semantic approach using ARIA snapshots and ref-based interactions, with performance optimizations, network monitoring, multi-tab support, and diagnostic tools.

## Architecture
-   **Service**: `@deedee/mcp-server-browser`
-   **Engine**: Playwright (System Chromium on Raspberry Pi)
-   **Persistence**: Uses a persistent profile in `browser-profile`. Cookies and logins survive restarts.
-   **Modularity**: The server is split into `state.js`, `snapshot.js`, `interactions.js`, `wait.js`, `vision.js`, `screencast.js`, `resource-blocker.js`, `console.js`, `network.js`, and `downloads.js`.

## Primary Workflow: Ref-Based Interactions

Instead of brittle CSS selectors, the agent uses **refs** (e.g., `e1`, `e2`) mapped to interactive elements on the page.

1. **Navigate**: `browser_navigate(url)` auto-returns a compact ARIA snapshot with refs.
2. **Snapshot**: `browser_snapshot()` can be called anytime to get the current page structure and available refs.
3. **Interact**: Use tools like `browser_click(ref)`, `browser_type(ref, text)`, `browser_fill_form`, etc., using the refs from the snapshot.
4. **Auto-Snapshot**: Click, type (with submit), fill_form, select, and press_key automatically return an updated snapshot. Use `autoSnapshot: false` to opt out.

## Tools Overview

### Navigation & Inspection
-   `browser_navigate`: Visit a website and get a snapshot.
-   `browser_snapshot`: Get the page's ARIA accessibility tree with refs. Supports interacting inside iframes via `frameSelector`.
-   `browser_screenshot`: Take a screenshot. Supports `--withLabels` to draw bounding boxes with ref labels without mutating the DOM.
-   `browser_extract_text`: Extract visible text content as Markdown. Uses Mozilla Readability for article content with fallback to Turndown. Supports `selector` param to target specific sections.

### Interaction (Ref-Based)
All interaction tools support optional `timeoutMs` to handle slow SPAs, and `frameSelector` to interact with cross-origin iframes. Successful interactions automatically include an updated ARIA snapshot in the response (opt out with `autoSnapshot: false`).
-   `browser_click`: Click an element by ref.
-   `browser_type`: Type text into an element by ref.
-   `browser_fill_form`: Batch-fill multiple inputs quickly.
-   `browser_select`: Select dropdown options.
-   `browser_hover`: Hover over an element.
-   `browser_scroll`: Scroll to an element or directionally.
-   `browser_press_key`: Press keyboard keys.
-   `browser_drag`: Drag an element to another by their refs.

### Waiting & Advanced
-   `browser_wait`: Wait for text to appear/disappear, URLs to match, load states, network responses (`networkUrl`), or fixed time.
-   `browser_evaluate`: Run arbitrary Javascript on the page.

### Network Monitoring
-   `browser_network_log`: View recent network requests. Filter by `urlFilter`, `resourceType`, or `limit`. Essential for debugging API calls and understanding SPA data flow.
-   `browser_wait_for_response`: Wait for a network response matching a URL pattern. Returns the response body — critical for capturing AJAX results like flight prices or search results.
-   `browser_get_response_body`: Get the most recent response body matching a URL pattern.

### Console & Diagnostics
-   `browser_console_messages`: View captured browser console messages. Filter by `level` (error, warn, log, info, debug). Optionally `clear` after reading.

### Performance
-   `browser_set_resource_blocking`: Control which resource types are blocked. Default blocks images, fonts, media, and known ad/tracker domains for faster page loads. Pass `["none"]` to disable blocking when you need images.

### Multi-Tab
-   `browser_list_tabs`: List all open tabs with index, URL, and title.
-   `browser_new_tab`: Open a new tab, optionally navigating to a URL.
-   `browser_switch_tab`: Switch to a tab by index.
-   `browser_close_tab`: Close a tab by index.

### Downloads & Uploads
-   `browser_list_downloads`: List recently downloaded files with paths and sizes.
-   `browser_upload_file`: Upload files to a file input by ref. Paths are validated against an allowlist (user data dir, /tmp, ~/Downloads).

### Cookies & Storage
-   `browser_get_cookies`: Get cookies, optionally filtered by URL.
-   `browser_set_cookie`: Set a cookie with name, value, domain, and optional attributes.
-   `browser_clear_cookies`: Clear cookies, optionally filtered by domain.
-   `browser_local_storage`: Interact with localStorage — `get`, `set`, `delete`, or `list` actions.

### Identity & Secrets
To avoid leaking passwords in context, utilize the Secret Store:
1.  **List Secrets**: `browser_list_secrets()` shows available keys (filters for `BROWSER_SECRET_` env vars and `browser-secrets.json`).
2.  **Use Secrets**: `browser_fill_secret(ref, secretKey)` types the value securely directly into the Playwright frame.

## Resilience & Stability
-   **AI-Friendly Errors**: If Playwright fails due to an element being intercepted (e.g., covered by a modal) or timing out, the MCP server intercepts the crash and returns an actionable error message to the agent instead of throwing an unhandled exception. Recent console errors are appended to interaction failure messages for better diagnostics.
-   **Snapshot Truncation**: To protect LLM memory limits, `browser_snapshot` output is capped at 20,000 characters.
-   **Iframe Tunneling**: Elements inside cross-origin iframes (like Captchas or Stripe checkouts) can be accessed seamlessly by passing `frameSelector` to snapshot and interaction tools.
-   **Resource Blocking**: Images, fonts, media, and ad trackers are blocked by default, significantly reducing page load times on complex sites (airlines, e-commerce).
-   **Network Waiters Cleanup**: Pending network waiters are automatically rejected on page navigation to prevent hanging promises.
-   **Download Safety**: Filenames are sanitized (path traversal prevention, null byte removal, length limits), and files are saved atomically with timestamp suffixes to prevent race conditions.
-   **Upload Path Validation**: File uploads are restricted to allowed directories to prevent arbitrary filesystem access.

## Configuration (Env Vars)
-   `BROWSER_HEADLESS`: `true` (default) or `false`.
-   `BROWSER_USER_DATA_DIR`: Path to profile.
-   `BROWSER_EXECUTABLE_PATH`: Path to custom chromium executable (Automatic on Docker).
-   `INTERFACES_URL` / `DEEDEE_API_TOKEN`: Used for the CDP live screencast relay.
