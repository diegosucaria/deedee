# Agentic browsing (browser v3)

Deedee browses with one MCP server: `@playwright/mcp` (pinned to 0.0.81),
started by `mcp-manager` like every other server. It drives the system
Chromium on a persistent profile. Spec: `specs/048-browser-v3.md`.

## Parts

- **Server entry**: `browser` in `apps/agent/mcp_config.json`. The command is
  `node scripts/browser-mcp.js …` with the Playwright CLI flags. Tools are named
  `browser_*`. `browser_run_code_unsafe` and `browser_close` are excluded.
- **Launcher stub**: `apps/agent/scripts/browser-mcp.js`. Before the real CLI it
  clears a stale Chromium profile lock (only when the lock's pid is dead or not
  Chromium), creates an empty secrets file when missing, and checks that port
  9222 is free. A busy port exits 1 with a clear message.
- **Playwright config**: `apps/agent/playwright-mcp.config.json`. Adds
  `--remote-debugging-port=9222` so the live viewer can attach, turns off the
  Chromium sandbox (the container runs as root), and sets a 1280x800 viewport.
- **Profile**: `${DATA_DIR}/browser_profile/chromium` (in the agent data
  volume). Cookies and logins survive restarts and deploys.
- **Output**: `${DATA_DIR}/browser_profile/output` (screenshots, downloads).
- **Idle**: Chromium closes after 10 minutes without a tool call. The next
  call starts it again on the same profile.
- **Timeouts**: 45 s per navigation, 120 s per tool call (`callTimeoutMs`).

## How the model browses

1. `browser_navigate(url)` returns a snapshot: the page as an accessibility
   tree where every element has a `ref` (like `e12`).
2. `browser_click`, `browser_type`, `browser_select_option`, `browser_hover`
   and `browser_fill_form` take that `ref`. Most actions return a new snapshot.
3. `browser_take_screenshot` only to check visuals. The image goes to Gemini
   as `functionResponse.parts[].inlineData`; the DB row and the UI keep only a
   count. If the model rejects that shape, the agent resends the text result
   and then the image as a separate user message.
4. Browser calls run one at a time and are exempt from loop detection.

The prompt rules live in `apps/agent/src/prompts/system.js` (BROWSER PROTOCOL).

## Secrets by name

Diego saves secrets in **Settings > Browser secrets** as a JSON map
(`{"SITE_USER": "...", "SITE_PASSWORD": "..."}`). Names must match
`^[A-Z0-9_]+$`. The agent stores `browser-secrets.json`, renders
`browser-secrets.env` for the server's `--secrets` flag, and restarts the
browser server (after any running browser call ends). It renders the `.env`
again on every boot.

The model only ever sees the names, listed in each turn's context. It types a
name with `browser_type`; the server swaps it for the value on an exact match.
Tool output shows values as `<secret>NAME</secret>`. The `$SECRET` skill
substitution is skipped for `browser_` tools so names reach the server as typed.

A save restarts Chromium. Someone using the live viewer at that moment sees the
browser close; the profile keeps the cookies.

## Live view and questions (stage B)

- `/browser` in the web app shows the page over CDP (port 9222), lets Diego
  type a URL, click and type, and log in himself. Any signed-in web user can
  drive it; fine for a single owner.
- `askUser` lets the model ask for an OTP, a CAPTCHA or a choice and wait for
  the next plain message in the chat.

## Failure modes

- Chromium crash: the tool returns an error; the next call relaunches it.
- Stale `SingletonLock` after a hard kill: the stub removes it.
- Port 9222 busy: the stub exits 1; `getStatus` shows the server down;
  `POST /internal/mcp/reload` starts it again once the port is free.
- Server death: the next call restarts the server once and retries.
- Secrets file missing: the server starts with no secrets.

## Smoke test

`node apps/agent/scripts/browser-smoke.js` starts the server with the args from
`mcp_config.json` in a temp `DATA_DIR`, navigates to a `data:` URL, checks the
snapshot text, checks that a screenshot returns an image, and checks that
`http://127.0.0.1:9222/json/version` answers. CI runs it on
`node:24.18.0-alpine` with Alpine Chromium (job `browser-smoke`). Run it inside
the agent container after a deploy too. Set `BROWSER_EXECUTABLE_PATH` to use
another binary.

## Env

- `BROWSER_EXECUTABLE_PATH`: Chromium binary. `/usr/bin/chromium-browser` in
  the container; unset on a dev box lets Playwright pick its own.
- `DATA_DIR`: agent data dir; `/app/data` in the container.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`: set in the image; the system Chromium
  is used instead of a download.
