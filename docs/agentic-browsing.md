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
  Chromium), creates an empty secrets file when missing, and waits up to 15 s
  for port 9222 to be free (on a restart the old Chromium may hold it for a
  few seconds). A port still busy after that exits 1 with a clear message.
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

## Live view

`/browser` in the web app shows the page the MCP server drives and lets Diego
type a URL, click, type and log in himself. The Sidebar links to it, and the
chat widget (`LiveBrowserWidget`) shows the same frames while the agent uses
the browser, with a link to the full page.

- **Agent**: `apps/agent/src/services/browser-live.js` speaks raw CDP over the
  global `WebSocket` to Chromium's debug port (9222, read from
  `playwright-mcp.config.json`). It picks the focused page target from
  `/json/list`, runs `Page.startScreencast` (JPEG, quality 50, max 1280x800,
  every 2nd frame), acks each frame and broadcasts at most 5 per second as
  `browser:frame { data, w, h, url }`. `w` and `h` are viewport pixels; the
  viewer scales mouse positions to them. Input maps to
  `Input.dispatchMouseEvent`, `Input.insertText` (printable text) and
  `Input.dispatchKeyEvent` (Enter, Tab, Backspace, Escape, Delete, arrows,
  Home, End, PageUp, PageDown). The URL bar calls `Page.navigate`; only
  `http`, `https` and `about:blank` pass.
- **Watch pings**: the page sends `browser:watch` every 10 s. The screencast
  starts on the first ping, stops 30 s after the last one, and reconnects
  every 3 s while watched if Chromium closes. While watched the service
  calls `browser_tabs list` every 5 minutes through `mcp.callTool`, so the
  server's idle timer does not close Chromium under Diego. This call skips
  the agent loop, history and the `agent:tool_call` broadcast.
- **Start**: `mcp.callTool('browser_navigate', { url: 'about:blank' })`, so
  the MCP server stays the only launcher.
- **Status**: `browser:status { running, url, agentBusy, watchers }` goes out
  on change. `agentBusy` is true while a `browser_` tool call is in flight.
  The viewer then locks input until "Take over" is pressed; the lock returns
  with the agent's next call.
- **Routes**: agent `POST /internal/browser/live/watch|input|navigate|start`
  and `GET /internal/browser/live/status` (bearer `DEEDEE_INTERNAL_TOKEN`).
  The interfaces service maps socket events `browser:watch`, `browser:input`
  and `browser:navigate` to them and drops input above 60 events per second
  per socket. The API proxies `GET /v1/browser/status` and
  `POST /v1/browser/start` for the page's first render.
- **Access**: any signed-in web user can watch and drive the browser. Fine
  for a single owner.

### Login sequence

Open `/browser`, press Start, type the site URL, log in with real keystrokes
and handle the OTP on the phone. Cookies land in `browser_profile/chromium`.
Leave; idle closes Chromium after 10 minutes. Later the model's
`browser_navigate` relaunches on the same profile and the snapshot shows the
site logged in.

## Questions to the user

- `askUser({ question, options?, timeoutSeconds? })` lets the model ask for an
  OTP, a CAPTCHA or a choice and wait. Default wait 300 s, max 900 s. The next
  plain text message in the reply chat is the answer; a number picks an option.
  The web chat shows options as chips. The model gets `{ answer }`,
  `{ cancelled: true }` or `{ timeout: true }`.
  - Reply chat: a web, Telegram or WhatsApp assistant run asks in its own chat.
    A scheduled job, a system run or a watcher run asks the owner on the
    notification channel. A sub-agent asks in its parent's chat when that is a
    live chat; otherwise the tool returns an error and the sub-agent reports
    what it needs.
  - One open question per reply chat. `/stop`, `/cancel` and the web Stop
    button end the wait. Open rows in `pending_questions` expire on boot; a
    reply within 10 minutes of an expiry gets "That question expired."
  - The question goes out through `interface.send`, so it shows at once even
    though the run is still going. The interfaces -> agent `/chat` call has no
    HTTP timeout; keep it that way, or the run dies while it waits.

## Failure modes

- Chromium crash: the tool returns an error; the next call relaunches it.
  The live view sees the socket close, shows "Browser closed" and Start.
- Stale `SingletonLock` after a hard kill: the stub removes it.
- Port 9222 busy: the stub waits up to 15 s, then exits 1; `getStatus` shows
  the server down; `POST /internal/mcp/reload` starts it again once the port
  is free.
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
