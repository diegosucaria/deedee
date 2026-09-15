# Deedee browser v3 — final design

Base: the [minimal] design. Grafted: saved-config migration and guarded lock cleanup ([reliability]); per-server restart, take-over lock, sub-agent routing via parent chat, option chips ([ux]); every judge must-fix.

## 1. Architecture

One pinned `@playwright/mcp@0.0.81` stdio server, spawned by `mcp-manager` like every other server. It launches the system Chromium itself on a persistent profile under the agent data volume. Its `--idle-timeout` closes Chromium after 10 idle minutes; the next tool call relaunches it. Chromium also listens on `127.0.0.1:9222` (passed via `launchOptions.args`; Playwright only rejects `--user-data-dir` and `--remote-debugging-pipe`, and its `waitForReadyState` handles a user port). A small agent module, `browser-live.js`, speaks raw CDP over Node 24's global `WebSocket` to that port: it streams JPEG frames and injects mouse and key input for a new `/browser` page. Frames go out through the existing `interface.broadcast('browser:frame')` path; input comes back through the existing socket and the interfaces -> agent `/internal/*` path with `DEEDEE_INTERNAL_TOKEN`. Screenshots reach Gemini as `functionResponse.parts[].inlineData`. Secrets stay in the Settings UI; the agent renders a dotenv file for `--secrets`. `askUser` is an internal tool that persists a row, sends the question via `interface.send`, and blocks until the next plain-text message in the reply chat.

No new services. No new npm dependencies except `@playwright/mcp`. No Deedee-owned Chromium launcher (its premise, that Playwright rejects `--remote-debugging-port`, is false).

## 2. File list

**Add**
- `apps/agent/scripts/browser-mcp.js` — launcher stub: preflight (stale lock, port check), then `require('@playwright/mcp/cli.js')`.
- `apps/agent/playwright-mcp.config.json` — launchOptions/contextOptions.
- `apps/agent/scripts/browser-smoke.js` — CI and on-Pi smoke test.
- `apps/agent/src/services/ask-user.js`
- `apps/agent/src/services/browser-live.js`
- `apps/agent/src/utils/function-response.js`
- `apps/agent/src/utils/browser-profile.js` — lock cleanup + port probe (used by stub and tests).
- `apps/api/src/routes/browser.js` — `GET /v1/browser/status`, `POST /v1/browser/start`.
- `apps/web/src/app/browser/page.js`, `apps/web/src/components/BrowserViewer.js`
- Tests: `apps/agent/tests/ask-user.test.js`, `browser-live.test.js`, `function-response.test.js`, `browser-profile.test.js`, additions to `mcp-manager.test.js`, `tool-groups.test.js`.

**Change**
- `apps/agent/mcp_config.json`, `apps/agent/package.json`, `apps/agent/src/mcp-manager.js`, `apps/agent/src/agent.js`, `apps/agent/src/tools-definition.js`, `apps/agent/src/prompts/system.js`, `apps/agent/src/services/tool-groups.js`, `apps/agent/src/routes/internal.js`, `apps/agent/src/command-handler.js`, `apps/agent/src/db.js`, `apps/agent/Dockerfile`, `docker-compose.yml`, `apps/interfaces/src/server.js`, `apps/web/src/components/Sidebar.js`, `apps/web/src/components/LiveBrowserWidget.js`, `.github/workflows/ci.yml`, `docs/agentic-browsing.md`, `docs/mcp-configuration.md`, root `package.json`.

**Delete**
- `packages/mcp-servers/browser-use/` (all), `packages/mcp-servers/browser/` (all).

## 3. MCP config

`apps/agent/mcp_config.json` — remove `browser` and `browser-use`, add:

```json
"browser": {
  "transport": "stdio",
  "command": "node",
  "args": ["scripts/browser-mcp.js", "--headless",
    "--user-data-dir", "${DATA_DIR}/browser_profile/chromium",
    "--secrets", "${DATA_DIR}/browser_profile/browser-secrets.env",
    "--config", "playwright-mcp.config.json",
    "--idle-timeout", "600000", "--timeout-navigation", "45000",
    "--image-responses", "allow"],
  "cwd": "../../apps/agent",
  "env": { "PLAYWRIGHT_MCP_EXECUTABLE_PATH": "${BROWSER_EXECUTABLE_PATH}",
           "DATA_DIR": "${DATA_DIR}" },
  "excludeTools": ["browser_run_code_unsafe", "browser_close"],
  "callTimeoutMs": 120000,
  "disabled": false
}
```

Notes. `cwd` resolves from the saved config dir (`/app/data`) to a missing path, then the existing auto-repair resolves it against `process.cwd()` = `/app/apps/agent` (verified at mcp-manager.js:238-250). In dev it resolves directly. `mcp-manager` maps `node` to `process.execPath`. `${VAR}` substitution in `args` does not exist today; add it (same regex as `env`). `_findMissingEnvVars` must treat `DATA_DIR` and `BROWSER_EXECUTABLE_PATH` as optional with defaults (`./data`, unset) so dev boxes do not silently disable the server. `PLAYWRIGHT_MCP_EXECUTABLE_PATH` is read by the 0.0.81 bundle (verified by the [ux] author; re-check during implementation). `browser_close` is excluded so the model cannot close the browser under a live viewer; idle timeout handles closing.

`apps/agent/playwright-mcp.config.json`:

```json
{ "browser": {
    "launchOptions": { "args": ["--remote-debugging-port=9222",
      "--remote-debugging-address=127.0.0.1", "--disable-gpu",
      "--renderer-process-limit=2"] },
    "contextOptions": { "viewport": { "width": 1280, "height": 800 } } },
  "outputDir": "/app/data/browser_profile/output", "outputMaxSize": 52428800 }
```

`outputDir` should also come from `DATA_DIR`; if the config file cannot interpolate, pass `--output-dir ${DATA_DIR}/browser_profile/output` in args instead and drop it from the JSON.

**Saved-config migration (must-fix).** Extend `_migrateConfig`: delete `userConfig['browser-use']`; if `userConfig.browser` exists and its `args` do not include `browser-mcp.js`, replace the whole entry with the default. Log both. Without this the Pi keeps its saved entries (mcp-manager.js:103-112 only adds missing keys) and never starts the new server.

**Launcher stub** `scripts/browser-mcp.js`: parse `--user-data-dir` from argv; call `clearStaleProfileLock(dir)` (remove `SingletonLock/Socket/Cookie` only when `readlink` pid is dead or `/proc/<pid>/cmdline` is not chromium); probe `127.0.0.1:9222` with a TCP connect; if busy, print a clear error to stderr and exit 1 (playwright would otherwise hang on "DevTools listening on" until its launch timeout). Then `require('@playwright/mcp/cli.js')`. The stub runs on every (re)spawn, including `restartServer`.

## 4. Dockerfile and compose

`apps/agent/Dockerfile`: delete line 25 (`COPY packages/mcp-servers/browser/package.json ...`) and the `uv pip install -r packages/mcp-servers/browser-use/requirements.txt` line. Keep `apk add chromium ...`, `BROWSER_EXECUTABLE_PATH`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. Add `RUN chromium-browser --version` after apk so the build log records the version (apk exact pins break when Alpine drops a build). `apps/agent/package.json`: remove `@deedee/mcp-server-browser`, add `"@playwright/mcp": "0.0.81"` (exact; its playwright dependency is an alpha, so `package-lock.json` pins it). Root `package.json`: drop the `packages/mcp-servers/browser` workspace. `docker-compose.yml`: add `shm_size: 256m` to `agent` (cheap insurance; Playwright already passes `--disable-dev-shm-usage` and `--no-sandbox`). No `mem_limit` until RSS is measured on the Pi.

## 5. Agent code changes

**mcp-manager.js**
- `_callClient`: replace `LONG_RUNNING_PREFIXES` with per-server `callTimeoutMs` (default SDK 60 s); keep the AbortController path so `/stop` cancels. Collect `content` items with `type === 'image'` into `_images: [{mimeType, data}]`; join text as today.
- `${VAR}` substitution for `args`.
- `restartServer(name)`: close that client, respawn, refresh `toolMap` and the tool cache. Used by the secrets route. It kills Chromium (the pipe dies with the server), so the route defers the restart while a `browser_` call is in flight (check `_activeAbortControllers`).
- `_migrateConfig` as in section 3. Fix comments at line 32, 187, 485; `command-handler.js:27`; `mcp-manager.test.js:25`.

**function-response.js**
`buildFunctionResponseParts(call, apiResponse, images)` returns `{ model, db }`. `model` = `{ functionResponse: { name, response, parts: images.map(i => ({ inlineData: i })) } }`. `db` = same without `parts`, plus `response._images = '<n image(s) sent to model>'`. `@google/genai` 1.34.0 types `FunctionResponse.parts?: FunctionResponsePart[]` (genai.d.ts). Acceptance by `gemini-3-flash-preview` is **unverified**; test on day one with `scripts/gemini-image-response-smoke.js` (needs API key, run on the Pi).
Fallback chain in `agent.js` around line 2207: on a 400 that mentions `parts`, resend the function responses without `parts`, then a **separate** user content `{ role: 'user', parts: [{ text: 'Screenshot from browser_take_screenshot:' }, { inlineData }] }` through `_generateStream`. Do not mix `inlineData` into the same content as `functionResponse` parts. Third fallback: text only.

**agent.js**
- At line ~2108: strip `_images` off `result` before `executionSummary.toolOutputs.push`, `sanitizeToolResult`, the DB row and `previewForUI` (the `/chat` response returns `toolOutputs` to callers).
- In `_executeTool`, skip the `$SECRET` argument substitution for `browser_` tools; secret names go to the server as-is.
- Keep the `browser_` loop exemptions and sequential execution (lines 1861-1925); tool names stay `browser_*` because no `namespace` is set.
- `processMessage`: askUser interception (section 6) before the stop-flag clear at line ~988.

**tools-definition.js**: add `askUser`; line 283 already names `browser_navigate`, now correct.

**tool-groups.js**: drop `'browser-use'` (line 31), description `'opening or acting on web pages (Playwright browser)'`, name words `['browser', 'playwright']`.

**prompts/system.js:108-138**: rewrite BROWSER PROTOCOL. Navigate -> `browser_snapshot` -> act by `ref` -> `browser_take_screenshot` only to check visuals. Type secret NAMES exactly as listed (the server substitutes the value only on an exact match). For OTP, CAPTCHA or a choice, call `askUser`. If a site needs a fresh login, tell Diego to log in at `/browser`. Inject the secret names list from the JSON file each turn.

**Secrets** (`routes/internal.js:709-750`): POST writes `browser-secrets.json` as today and renders `browser-secrets.env` (`KEY="value"`, escape `"` and `\`, reject keys not matching `^[A-Z0-9_]+$`). Then `agent.mcp.restartServer('browser')`, deferred if a browser call is active. On boot, regenerate the `.env` from the JSON before `mcp.init()`. Values never enter the prompt or tool output: playwright-mcp's `redactSecrets` rewrites them as `<secret>NAME</secret>`.

## 6. askUser

Tool: `askUser({ question, options?, timeoutSeconds? })`, default 300 s, max 900 s. Internal, so no MCP timeout applies.

Table `pending_questions(id, chat_id, reply_chat_id, reply_source, source, question, options, status, answer, created_at, expires_at, answered_at)` in `db.js`.

Flow (`services/ask-user.js`):
1. Route. Interactive runs (`web`, `whatsapp:*`, `telegram`): reply target = the origin `chatId` and `source`. Scheduler/system runs: owner channel as `scheduler.js:534` does (`${owner_phone}@s.whatsapp.net`, `notification_channel`). Sub-agents: use `parentChatId` when the parent session source is a live chat; else return `{ error: 'askUser unavailable; report what you need to the parent' }`.
2. Insert row `status='pending'`. Send the question with `this.interface.send({ source, metadata: { chatId, question: { id, options } } })`. Never use `activeSendCallback`: `server.js:196-220` collects callback replies and returns them only when `processMessage` ends, so on web the question would never show. `/send` with `source: 'web'` emits to the chat room at once (interfaces `server.js:613-630`, verified). Also `notifications.create` with a link to the chat, and `broadcast('agent:question', ...)`.
3. Await a promise held in an in-memory map keyed by `reply_chat_id`. Race against the timeout and a 1 s poll of `stopFlags`.
4. Interception at the top of `processMessage`, before the stop-flag clear and before `commandHandler`: if `findPending(chatId)` exists and the message is plain text not starting with `/`, save the user message to history, update the row (`answered`, `answer`), resolve the promise, and return `executionSummary` with an ack reply ("Got it."). `/stop` and `/cancel` reject the wait (`cancelled`) and then run as usual; `command-handler` `/stop` also calls `askUser.cancelAll()`.
5. Result to the model: `{ answer }`, `{ cancelled: true }` or `{ timeout: true }`. On boot, mark leftover `pending` rows `expired` (same pattern as `markStaleSubAgents`). A late reply to an expired question gets "That question expired." One pending question per reply chat; a second `askUser` errors.

Web chat renders `metadata.question.options` as chips that send the option text. Constraint to document: interfaces -> agent `/chat` must keep no HTTP timeout (today's 15-minute browser-use tasks already rely on this). Confirm no per-chat lock parks the reply request behind the waiting run; only the watcher in-flight lock exists today (**verify during implementation**).

## 7. Live view

**browser-live.js** (~150 lines). `GET http://127.0.0.1:9222/json/list`; pick the focused `page` target, or the first. Open its `webSocketDebuggerUrl` with global `WebSocket`. On first watcher: `Page.startScreencast { format: 'jpeg', quality: 50, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 }`; on each `Page.screencastFrame`, `Page.screencastFrameAck` then `interface.broadcast('browser:frame', { data, w, h, url })`. Cap 5 fps. Input: `Input.dispatchMouseEvent` (mouseMoved/Pressed/Released/mouseWheel), `Input.insertText` for printable text, `Input.dispatchKeyEvent` for Enter, Tab, Backspace, Escape, arrows (with `windowsVirtualKeyCode`). `Page.navigate` for the URL bar. Coordinates arrive in viewport pixels; the page scales by `w/h` from the frame. Stop screencast 30 s after the last `watch` ping; reconnect with 3 s backoff while watched; report `{ running: false }` when no target exists. While watched, call `this.mcp.callTool('browser_tabs', { action: 'list' })` every 5 min directly (bypasses the agent's sequential lock, loop detection, `agent:tool_call` broadcasts and history) so the idle timer does not close the browser under Diego. "Start" calls `mcp.callTool('browser_navigate', { url: 'about:blank' })` the same way, so the MCP server stays the sole launcher. Broadcast `browser:status { running, url, agentBusy, watchers }` on change; `agentBusy` = a `browser_` call in flight.

**Agent routes** (`routes/internal.js`, bearer `DEEDEE_INTERNAL_TOKEN`): `POST /internal/browser/live/watch`, `/input`, `/navigate`, `/start`, `GET /internal/browser/live/status`.

**Interfaces** (`server.js`): add socket handlers `browser:watch`, `browser:input`, `browser:navigate` on cookie-authenticated sockets; forward to the agent routes with axios (token injected by the interceptor at lines 23-28). Rate cap per socket: 60 input events/s, drop extras. Add `browser:frame` to the `/broadcast` log suppression at line 812 (today every non-`agent:token` event logs a line). Keep the trusted-producer `browser:frame` relay for compatibility.

**Web**: `/browser` page with `BrowserViewer`: `<img>` for frames, URL bar, Start button, status pill. When `agentBusy`, input is locked until "Take over" is pressed. Keyboard capture on focus; mouse events scaled to frame size. Emits `browser:watch` every 10 s while mounted. Sidebar item `{ name: 'Browser', href: '/browser' }`. `LiveBrowserWidget` keeps showing frames in chat, sends `browser:watch` while visible, and links to `/browser`.

**API**: `apps/api/src/routes/browser.js` mounted at `/v1/browser` (session/bearer auth) proxies `status` and `start` to the agent for the page's first render. Any authenticated web user can drive the browser; acceptable for a single owner, note it in docs.

**Login sequence.** Diego opens `/browser`, presses Start (Chromium launches via `browser_navigate about:blank`), types the site URL, logs in with real keystrokes, handles OTP on his phone. Cookies land in `browser_profile/chromium`. He leaves; idle closes Chromium after 10 min. Later "check my bill": the model calls `browser_navigate`, the server relaunches Chromium on the same profile, the snapshot shows him logged in. If the site asks for a code, the model calls `askUser`; Diego replies in WhatsApp; the model calls `browser_type` with the code.

## 8. Idle, RAM, failures

RAM (estimates, unmeasured on the Pi): Chromium tree 200-600 MB with one heavy tab, MCP node process 80-120 MB. Idle close returns it all after 10 min. Pipe launch means Chromium dies with the MCP process, which dies with the agent; no orphans across restarts. Measure RSS on the Pi with one heavy site before adding any `mem_limit` (it would also cap the agent process).

- Chromium crash: tool returns an error; next call relaunches. Live view sees the socket close, shows "Browser closed" and Start.
- Stale `SingletonLock` after a hard kill: stub clears it when the pid is not a live chromium. Playwright-mcp's `isProfileLocked` uses `process.kill(pid, 0)`, so a reused pid would otherwise give a false "already in use".
- Port 9222 busy: stub exits 1 with a clear message; `getStatus` shows the server down; add a `notifications.create` when a `browser_` call hits "not connected"; `/internal/mcp/reload` recovers.
- MCP server death: no auto-respawn today (same for all servers). Add one `restartServer` retry when a call fails with a closed transport.
- Secrets file missing: server starts with no secrets.
- Slow page: navigation timeout 45 s beats the 120 s call timeout.

## 9. Tests

Jest: `_callClient` image extraction and per-server timeout; `${VAR}` args substitution; `_migrateConfig` drops `browser-use` and replaces a stale `browser` entry; `buildFunctionResponseParts` model vs DB shape; `_images` stripped from `toolOutputs`; ask-user route/answer/timeout/cancel/expire-on-boot/sub-agent rules with a fake `interface.send`; browser-live pure mapping of UI events to CDP messages and watcher gating with a fake WebSocket; `browser-profile` lock cleanup (live vs dead pid) and port probe; secrets JSON -> dotenv escaping; tool-groups names.

CI job `browser-smoke` in `ci.yml`: `container: node:24.18.0-alpine`, `apk add chromium nss freetype harfbuzz ca-certificates ttf-freefont python3 make g++`, `npm ci`, `node apps/agent/scripts/browser-smoke.js`. The script prints `chromium-browser --version`, spawns the server through the MCP SDK with the exact args from `mcp_config.json` (env `BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser`, temp `DATA_DIR`), calls `browser_navigate` to a `data:` URL, asserts snapshot text, asserts `browser_take_screenshot` returns an `image` item, asserts `GET 127.0.0.1:9222/json/version` answers while the server holds the pipe, then closes. The same script runs inside the Pi container after deploy.

## 10. Cleanup

Delete both server packages; Dockerfile and root workspace edits (section 4); Balena vars `BROWSER_USE_HEADLESS`, `BROWSER_HEADLESS` and the `GOOGLE_API_KEY` reference in the old browser entries; remove `browser_use_` from mcp-manager, agent comments, command-handler and prompt; rewrite `docs/agentic-browsing.md` (engine, profile path, secrets by name, `/browser`, askUser) and the browser section of `docs/mcp-configuration.md`; leave `specs/` as history.

## 11. Risks and unknowns to verify

1. Gemini 3 preview accepting `FunctionResponse.parts` inlineData — typed in the SDK, unverified live. Fallback chain in section 5; run the smoke script before merge.
2. Pipe + `--remote-debugging-port` at once — Playwright code supports it; the CI smoke asserts it. If it fails, fall back to an agent-owned launcher with `--cdp-endpoint` (the [ux] design).
3. Alpine Chromium version in `node:24.18.0-alpine` vs playwright 1.64-alpha — unknown version; CI on the same base image is the gate.
4. `PLAYWRIGHT_MCP_EXECUTABLE_PATH` env name and `outputDir` in the config file — re-check in the 0.0.81 bundle.
5. RAM and screencast CPU on the Pi — measure; tune `quality`, `everyNthFrame`, idle timeout.
6. Secret substitution needs an exact name match; the prompt must list names verbatim.
7. askUser takes the next plain-text message in the chat as the answer; an unrelated message becomes the answer. Option chips and clear question text reduce this.
8. Secrets save restarts the MCP server and thus Chromium; the deferral avoids killing a running task but a viewer mid-login will see the browser close. Document it; the profile keeps cookies.
9. `cwd` auto-repair relies on `process.cwd()` being `/app/apps/agent` in the container — verify from the Dockerfile `CMD`/`WORKDIR`.

## 12. Verified

Checked on an x86 devbox (2026-09-15) and again during implementation:

- Playwright keeps its pipe when `launchOptions.args` adds `--remote-debugging-port`; Chromium also serves `/json/version` and `/json/list` on that port. The CI smoke asserts this on Alpine.
- `@playwright/mcp@0.0.81` reads `PLAYWRIGHT_MCP_EXECUTABLE_PATH`, `PLAYWRIGHT_MCP_CONFIG`, `PLAYWRIGHT_MCP_HEADLESS` and `PLAYWRIGHT_MCP_CDP_ENDPOINT`. `--secrets <path>` loads a dotenv file. `lookupSecret` matches names exactly; `redactSecrets` rewrites values as `<secret>NAME</secret>`.
- `outputDir` in the config file goes through `path.resolve` with no `${VAR}` expansion, so the agent passes `--output-dir` in args instead.
- Its `isProfileLocked` reads the `SingletonLock` symlink and calls `process.kill(pid, 0)`; a reused pid gives a false "already in use", which the launcher stub guards against.
- `@google/genai` 1.34.0 types `FunctionResponse.parts?: FunctionResponsePart[]`.
- The agent container has `WORKDIR /app/apps/agent` and `CMD npm start`, so `process.cwd()` is `/app/apps/agent` and the `cwd` auto-repair resolves `../../apps/agent` there.
- Node 24 has a global `WebSocket`.
