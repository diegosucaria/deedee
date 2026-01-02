# Deedee: Self-Improving AI Agent

Deedee is a **personal, autonomous AI agent** designed to run on a Raspberry Pi (or any Docker-capable host). It acts as a persistent companion that connects to your chat platforms (Telegram, Slack) and digital tools (Google Workspace).

**Core Philosophy**:
1.  **Self-Improvement**: Deedee can modify its own code to add features or fix bugs.
2.  **Privacy & Ownership**: Runs on *your* hardware. You own the database and the logs.
3.  **Resilience**: A "Supervisor" service monitors the agent and automatically rolls back bad updates.

---

## 🚀 Features

*   **Smart Router Architecture**: Uses `Gemini 2.0 Flash` for instant intent routing and `Gemini Pro` for complex reasoning.
*   **Infinite Persistence**: Remembers conversations forever (stored in SQLite, hydrated per-turn).
*   **Self-Correction**: If the agent pushes broken code, the Supervisor detects the crash and reverts it.
*   **Tool Use (MCP)**:
    *   **Filesystem**: Read/Write local files.
    *   **System**: Run shell commands (controlled).
    *   **Google Workspace**: Calendar & Gmail access (via MCP).
    *   **Memory**: Long-term fact storage.
*   **Interfaces**: Chat via Telegram or Slack.

---

## 🛠️ Architecture

The system consists of three Docker services:

1.  **Agent Logic** (`apps/agent`): The brain. Stateless, scalable Node.js service using Google Gemini.
2.  **Supervisor** (`apps/supervisor`): The immune system. Watchdog for health checks, git operations, and rollbacks.
3.  **Interfaces** (`apps/interfaces`): The ears. Adapters for Chat platforms.

See [docs/architecture.md](docs/architecture.md) for a deep dive.

---

## 📋 Requirements

*   **Docker** & **Docker Compose**
*   **Node.js 18+** (for local development)
*   **Git**

### Environment Variables

You must configure these variables (e.g., in a `.env` file or Balena Dashboard):

| Variable | Description | Required? |
| :--- | :--- | :--- |
| `GOOGLE_API_KEY` | Gemini API Key (AI Studio). | **Yes** |
| `GITHUB_PAT` | GitHub Personal Access Token (Repo Scope). Used by Supervisor to push changes. | **Yes** |
| `GIT_REMOTE_URL` | HTTPS URL of *your* fork of this repo. | **Yes** |
| `TELEGRAM_TOKEN` | Telegram Bot Token (from @BotFather). | Yes* |
| `SLACK_TOKEN` | Slack Bot User OAuth Token (`xoxb-...`). | Yes* |
| `SLACK_APP_TOKEN`| Slack App-Level Token (`xapp-...`). | Yes* |
| `SLACK_WEBHOOK_URL`| Incoming Webhook URL for Supervisor Alerts. | No |
| `GIT_USER_NAME` | Git commit author name (Default: Deedee Agent). | No |
| `GIT_USER_EMAIL` | Git commit author email (Default: deedee@bot). | No |
| `ROUTER_MODEL` | Model for intent routing (Default: `gemini-3-flash-preview`). | No |
| `WORKER_PRO` | Model for reasoning (Default: `gemini-3-pro-preview`). | No |

*\* At least one chat platform is required.*

---

## ⚡ Deployment

### Option A: Balena Cloud (Recommended for RPi)
1.  Fork this repository.
2.  Create a defined application in Balena Cloud.
3.  Add the **Environment Variables** in the Balena Dashboard.
4.  Push code:
    ```bash
    balena push <app-name>
    ```

### Option B: Docker Compose (Local / VPS)
1.  Clone your fork.
2.  Create a `.env` file with the variables above.
3.  Run:
    ```bash
    docker-compose up --build
    ```

---

## 🛡️ Security
*   **Isolation**: The Agent runs unprivileged. Only the Supervisor has access to the full repository volume.
*   **Review**: The Agent is instructed to run `npm test` (via Supervisor) before committing any code.
*   **YOLO Mode**: By default, the agent has broad shell access to *its own container* to facilitate self-improvement. Use with caution.

## 🤝 Contribution
This project is typically run as a personal fork (so your agent can edit its own repo). If you want to contribute to the core framework, please open a PR!

---
