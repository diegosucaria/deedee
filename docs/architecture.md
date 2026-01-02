# Deedee Architecture

## System Overview
Deedee is a personal AI agent designed to run on a Raspberry Pi. It uses a microservices architecture orchestrated by Docker Compose. The system is designed for security, extensibility, and self-improvement.

## Components

### 1. Core Agent (`apps/agent`)
- **Runtime**: Node.js
- **Framework**: LangChain or Google GenAI SDK
The brain.
- **Goal:** Processes user requests, manages state, and decides which tools to call.
- **Logic:**
    - **Router:** Decides between `GEMINI FLASH` (fast, tools, light reasoning) and `GEMINI PRO` (deep reasoning, coding).
        - *Context-Aware:* Uses the last 3 messages to make smarter routing decisions.
        - *Multimodal:* Handles audio/images properly.
    - **MCP Manager:** Discovers and communicates with tools.
        - *Caching:* Caches tool definitions at startup to minimize latency.
    - **State:** Hydrates conversation history from SQLite / Vector DB on every turn.

### 2. Supervisor (`apps/supervisor`)
The immune system.
- **Goal:** Ensures the Agent doesn't break itself and handles self-updates.
- **Capabilities:**
    - Has full filesystem access (unlike the Agent, which is restricted).
    - Can run `git` commands, `npm install`, and restart the Agent container.
    - **Watchdog:** If the Agent code is broken (tests fail), it performs a hard reset.
    - Can be triggered by the Agent to apply a self-patch.

### 3. Interfaces (`apps/interfaces`)
The ears and mouth.
- **Goal:** Exposes the Agent to the outside world.
- **Supported Channels:**
    - **Telegram:** Polling bot.
        - *Security:* Supports `ALLOWED_TELEGRAM_IDS` to restrict access.
    - **HTTP Webhook:** For other integrations.
    - **WhatsApp**: (TBD - likely Baileys library).
- **Data Flow**:
    - Receives message -> `POST http://agent:3000/webhook` -> Agent.
    - Agent replies -> `POST http://interfaces:5000/send` -> Platform.

### 4. MCP Servers (`packages/mcp-servers`)
- **Runtime**: Sub-processes within the Agent container (for now) to save RAM.
- **Role**: Expose tools and data sources to the Agent via the Model Context Protocol.

### 4.1 MCP Integration Patterns
When adding a new MCP server, choose one of the following patterns:

#### A. Published Package (Preferred for Python)
Use when the server is published to PyPI (e.g., `ha-mcp`).
- **Config**: Use `uvx` (or `uv tool run`) to download and run it on usage.
- **Dockerfile**: No changes needed (if `uv` is installed).
```json
"homeassistant": {
    "command": "uvx",
    "args": ["ha-mcp"],
    "env": { ... }
}
```

#### B. Cloned Repository (Standalone)
Use for servers only available as source code (e.g., `plex-mcp-server`).
- **Location**: Clone into `packages/<server-name>`.
- **Dockerfile**: Update `apps/agent/Dockerfile` to install dependencies into the system or venv.
  ```dockerfile
  RUN uv pip install -r packages/<server-name>/requirements.txt
  ```
- **Config**: Configure `command` and `cwd`.
```json
"plex": {
    "command": "python3",
    "args": ["server.py"],
    "cwd": "../../packages/plex-mcp-server",
    "env": { ... }
}
```

#### C. Internal/Legacy (Built-in)
Use for custom tools integrated directly into the repo (e.g., `gsuite`).
- **Implementation**: Defined in `packages/mcp-servers` and imported in `agent.js`.
- **Note**: We are migrating away from this towards Config-based (Pattern A/B).

## Inter-Process Communication (IPC)
- **Protocol**: HTTP/JSON.
- **Network**: Internal Docker Network (no external access).
- **Agent (Port 3000)**: Accepts messages, tool results.
- **Supervisor (Port 4000)**: Accepts system commands (update, restart).
- **Interfaces (Port 5000)**: Accepts outgoing messages.

## Data Persistence
- **Agent**: Owns `agent.db` (SQLite). EXCLUSIVE ACCESS.
- **Supervisor**: Owns the git repo volume.


## Deployment & CI (Balena.io)
- **Platform**: BalenaOS (Raspberry Pi).
- **Update Mechanism**: 
    1. **Agent** creates a change.
    2. **Supervisor** pushes code to GitHub.
    3. **GitHub Actions** triggers `balena push`.
    4. **Balena Cloud** builds the containers.
    5. **Device** downloads and applies the update.
- **Local Development**: `balena push <device-ip> --local` or `balena push <app-name>` for manual deployments.

## Security Model
- **Network**: 
    - Containers run on an internal Docker network.
    - No direct public ingress for the Agent or Supervisor.
    - Reverse Proxy (Nginx/Traefik) handles SSL and IAP for any exposed webhooks or UI.
- **Secrets**: 
    - **Runtime Secrets** (Google API Key, Telegram Token): Managed via Balena Dashboard (Environment Variables).
    - **Build Secrets** (GitHub PAT): Injected into the Supervisor container or volume-mounted securely.

## Self-Improvement Loop
1. **Request**: User asks Agent to "add the ability to read PDF files".
2. **Planning**: Agent determines it needs a new npm package (`pdf-parse`) and code.
3. **Execution**:
    - Agent sends a "Code Modification" request to the Supervisor.
    - Supervisor applies changes locally.
    - Supervisor runs `npm test` (local verification).
    - Supervisor runs `git add .`, `git commit -m "feat: add pdf support"`, `git push`.
4. **Deployment**:
    - GitHub Action detects push.
    - Builds new release.
    - Pushes to Balena.
5. **Update**: Device restarts with new code.
6. **Verification**: Agent comes back online, checks its changelog, and confirms the capability.

## Development Workflow
- **TDD**: All features start with a Specification and a Test.
- **Monorepo**: Managed with NPM Workspaces.
