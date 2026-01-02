# Deedee Architecture

## System Overview
Deedee is a personal AI agent designed to run on a Raspberry Pi. It uses a microservices architecture orchestrated by Docker Compose. The system is designed for security, extensibility, and self-improvement.

## Components

### 1. Core Agent (`apps/agent`)
- **Runtime**: Node.js
- **Framework**: LangChain or Google GenAI SDK
- **Role**: Central brain. Processes user input, maintains memory, plans actions, and invokes tools.
- **Cognitive Architecture (Router-Worker)**:
    - **Layer 1 (Router)**: `Gemini 2.0 Flash`. Analyzes intent (strict JSON). Decides if a task is "Simple" or "Complex".
    - **Layer 2 (Workers)**:
        - **Fast Worker**: `Gemini 2.0 Flash`. Executes tools, home automation, and casual chat.
        - **Reasoning Worker**: `Gemini 1.5 Pro` (or higher). Handles coding, planning, and analysis.
    - **State Management**: Stateless execution. Context is "hydrated" from SQLite for every turn.
- **Dependencies**: 
    - Connects to MCP Servers for capabilities.
    - Connects to Interface adapters for communication.

### 2. Supervisor (`apps/supervisor`)
- **Runtime**: Node.js
- **Privileges**: Filesystem access to the source code repo.
- **Port**: 4000 (Internal).
- **Role**: The "Git Operator".
    - Exposes HTTP endpoints: `POST /cmd/update`, `POST /cmd/rollback`.
    - Watches for "Change Requests" from the Agent.
    - Applies code changes to the local git repository.
    - **Commits and Pushes** changes to GitHub.

### 3. Interfaces Service (`apps/interfaces`)
- **Runtime**: Node.js
- **Port**: 5000 (Internal).
- **Role**: Unified "Ears" of the system.
- **Communication Strategy**:
    - **Telegram**: Long Polling.
    - **Slack**: Socket Mode.
    - **WhatsApp**: (TBD - likely Baileys library).
- **Data Flow**:
    - Receives message -> `POST http://agent:3000/webhook` -> Agent.
    - Agent replies -> `POST http://interfaces:5000/send` -> Platform.

### 4. MCP Servers (`packages/mcp-servers`)
- **Runtime**: Sub-processes within the Agent container (for now) to save RAM.
- **Role**: Expose tools and data sources to the Agent via the Model Context Protocol.

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
