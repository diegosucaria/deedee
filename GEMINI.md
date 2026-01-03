# Deedee - AI Developer Instructions

You are working on **Deedee**, a personal, self-improving AI agent designed to run on a Raspberry Pi.

## 🧠 Project Context
- **Goal**: A persistent agent that helps the user via chat (Telegram/Slack) and can interact with their digital life (Calendar, Files, Web).
- **Architecture**: Microservices in a Monorepo.
  - **Agent**: The brain (LangChain/Gemini). Unprivileged.
  - **Supervisor**: The immune system/updater. Privileged (Filesystem/Git access).
  - **Web**: Next.js Dashboard & Chat.
  - **MCP Servers**: Tools exposed to the Agent.
- **Stack**: Node.js, Docker, Google Gemini, MCP (Model Context Protocol).
- **Deployment**:
  - **Repo**: [https://github.com/diegosucaria/deedee](https://github.com/diegosucaria/deedee)
  - **Target**: Balena Fleet `g_diego_sucaria/deedee` (Raspberry Pi).
  - **CI/CD**: GitHub Actions triggers `balena push`.

## 🛡️ Critical Mandates

### 1. Security First (Modified: "YOLO" Mode)
- **Operational Mode**: The Agent is a personal tool for a single user. We prioritize **Capability over Restriction**.
- **Shell Access**: The Agent is allowed broad access to `run_shell_command` (e.g., `rm`, `curl`, `git`).
- **Safety Net**: We do not prevent destructive actions (like deleting source code). Instead, we rely on the **Supervisor** to detect corruption and perform a "Hard Reset" (re-clone from GitHub) if necessary.
- **Secrets**: Continue to protect API Keys via environment variables (`GOOGLE_API_KEY`, `TELEGRAM_TOKEN`, `GITHUB_PAT`, `SLACK_WEBHOOK_URL`, `PLEX_URL`, `PLEX_TOKEN`, `DEEDEE_API_TOKEN`).
- **Access Control**: You must define `ALLOWED_TELEGRAM_IDS` (comma-separated strings) to prevent unauthorized access. Use `<YOUR_TELEGRAM_ID>` (User) as the primary ID.

### 4. API Security
- **Strict Authentication**: All external HTTP endpoints (e.g., exposed via `apps/api`) MUST be protected by Bearer Token authentication (`DEEDEE_API_TOKEN`).
- **No Public Endpoints**: Never expose functional endpoints publicly. Only `/health` may be public.
- **Middleware**: Use a dedicated auth middleware for all `/v1` routes.

### 2. TDD & Specs
- **Workflow**:
  1.  Read/Create a Spec file in `specs/`.
  2.  Write the Test first (Red).
  3.  Implement the Code (Green).
  4.  Refactor.
- **Do not skip tests.** The system is designed to be autonomous; tests are its guardrails.

### 3. Self-Improvement Philosophy
- The system should eventually be able to edit its own code.
- **Mechanism**: Agent -> Supervisor -> Local Git Commit -> Push -> GitHub Action -> Balena Build -> Update.

## ⚙️ Operational Mandates
- **TODO Updates**: You MUST update `TODO.md` automatically at the end of every chat turn if a task was completed or the status changed. Do not wait for the user to ask.
- **Context Updates**: Update `GEMINI.md` if new architectural decisions or secrets are introduced.

## 📂 Navigation
- **`TODO.md`**: The source of truth for current progress. Check this first.
- **`specs/`**: The detailed requirements for the current task.
- **`docs/architecture.md`**: The system map.

## 🚀 How to Resume Work
1. Read `TODO.md` to identify the current active task.
2. Check `specs/` for the corresponding requirement file.
3. Check GitHub Actions for build status if recently deployed.
4. Run `npm test` to see the current state of the codebase.
5. Continue the TDD cycle.
