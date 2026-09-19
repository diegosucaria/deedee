# Deedee: rules for coding agents

This is the one file of rules for anyone, human or model, who changes this
repo. `GEMINI.md` and `CLAUDE.md` only point here.

## What this is

Deedee is a personal AI agent for one owner. It runs on a Raspberry Pi through
Balena. The repo is **public**, and its API is reachable from the internet.
Both facts shape most of the rules below.

It is a Node monorepo (npm workspaces `apps/*` and `packages/*`):

| Folder | What it does |
|---|---|
| `apps/agent` | The brain: Gemini through `@google/genai`, the tool loop, the scheduler, SQLite (`agent.db`), approvals, memory |
| `apps/api` | The HTTP gateway. Every route but `/health` needs the bearer token |
| `apps/web` | Next.js dashboard and chat. Fetches data through Server Actions; live updates come over a socket |
| `apps/interfaces` | WhatsApp, Telegram and Slack connectors |
| `apps/supervisor` | Git, pull requests, health checks and rollback. Runs no code the agent wrote |
| `packages/shared` | Message types shared by the services |
| `packages/mcp-servers` | The local file and shell tools, and other MCP servers |
| `packages/node-red-mcp`, `packages/plex-mcp-server` | MCP servers for Node-RED and Plex |

Feature docs are in `docs/`; start with `docs/architecture.md` and
`docs/security.md`. Designs for large features are in `specs/`.

## Commands

- Node 24 (CI pins 24.18.0). Install with `npm ci` at the repo root.
- `npm test` runs every suite. **Run Jest from the repo root.** The root config
  gives each test file its own data folder; from inside a workspace that step
  is skipped.
- One file: `NODE_OPTIONS=--experimental-vm-modules npx jest apps/agent/tests/<file>.test.js`
- `npm run build` builds the web app. There is no repo-wide lint: only
  `apps/web` has an ESLint config (`npm run lint --workspace=apps/web`).
- CI runs four jobs: the personal-data scan, the tests, the web build and a
  browser smoke test.

## How a change ships

1. Branch from `master`. Never push to `master`.
2. Open a pull request. The owner reviews and merges it.
3. A merge to `master` builds and deploys to the device. The device takes a few
   minutes to pull the new release.
4. Use Conventional Commits (`feat(agent): ...`, `fix(web): ...`). Say what
   changed and why.

The agent's own self-improvement takes the same road: `commitAndPush` opens a
pull request, and a rollback is a revert pull request. Nothing reaches the
device before the owner merges.

## Rules

1. **No personal data, anywhere.** No names of the owner's contacts, phone
   numbers, WhatsApp or Slack ids, chat text, addresses, health details or
   credentials. This covers code, prompts, tests, fixtures, docs, commit
   messages and pull request text. Use placeholders: `Alice`, `+15550100`,
   `user@example.com`, `100000000000001@g.us`, `U01EXAMPLE1`.
   `scripts/check-pii.js` runs before every commit and in CI; names to block
   go in the gitignored `.pii-denylist` (see `docs/security.md`).
2. **Every new endpoint is authenticated.** Routes in `apps/api` need the
   bearer token; only its `/health` is public. Agent routes under `/internal`
   and `/tools` need the internal token. The agent's other routes (`/status`,
   `/webhook`, `/chat`, `/live/*`, `/v1/*`) have no check of their own and
   rely on the Docker network being closed, so a new agent route must bring
   its own check. No token ever reaches the browser: the web app fetches
   through Server Actions.
3. **A new tool is a security decision.** Classify it in
   `apps/agent/src/utils/untrusted-content.js` (our own text, or text a third
   party wrote). Decide whether it needs the owner's approval
   (`docs/security.md`, Approvals). Never weaken the deny-list, the safety
   rules or the always-ask floor to make a feature work.
4. **Tests come with the change.** Name a test after the fault it guards
   against. Prefer the real thing to a mock: a real `AgentDB` in a temp
   folder, the real router, a scripted model.
5. **The system prompt must match the code.** A rule that names a tool, a
   parameter, a file or a page must be true.
   `apps/agent/tests/system-prompt-accuracy.test.js` checks the names. A rule
   added after an incident stays; say why in the commit.
6. **A risky change gets a switch.** Read `process.env` on every call, default
   on, and let `NAME=0` turn it off (`HISTORY_TRIM`, `MESSAGES_FTS`,
   `FACTS_INDEX` are the pattern). Document it next to the feature.
7. **Measure before you optimise.** Token and cost work starts from
   `token_usage` on the device, not from a guess (`docs/models.md`).
8. **Keep the docs true.** Update `docs/` in the same pull request. Update
   this file when the rules for working here change. A large feature gets a
   design in `specs/` first.
9. **Do not downgrade a library** to fix an API mismatch. Adapt to the newer
   version.

## Writing

Docs, comments, commit messages and pull request text use plain English:
short sentences, everyday words, active voice. Cut every word you can. Keep
technical names exact: file paths, function names, numbers.

## Where things live

- `apps/agent/src/agent.js`: the turn: routing, tools for the turn, the tool
  loop, approvals, history.
- `apps/agent/src/tools-definition.js`: every internal tool's schema.
  `executors/` holds the code behind them.
- `apps/agent/src/prompts/`: the system prompts (`system.js` for chat,
  `live.js` for voice calls, `grok.js` for a model with no tools).
- `apps/agent/src/services/`: approvals and the guardian, delivery to the
  owner, sub-agents, the scheduler's helpers, tool groups, memory.
- `apps/agent/src/db.js`: SQLite schema and queries.
- `apps/web/src/app/actions.js`: the Server Actions (the web app's security
  boundary).
- `apps/supervisor/src/git-ops.js`: commits, pull requests, pull and rollback.
- `TODO.md`: the open task list. Update it when you finish a task.

Data lives under `DATA_DIR` (`/app/data` on the device) and is never
committed.
