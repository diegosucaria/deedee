# Spec 019: Plex Integration

**Goal**: Enable Deedee to interact with the user's Plex Media Server.

## 1. Background
The user wants to control and query their Plex library (movies, music, status) via natural language. We will leverage an existing MCP server implementation (`vladimir-tutin/plex-mcp-server`) instead of writing one from scratch.

## 2. Requirements

### 2.1 Functionality
-   **Library Query**: "What movies do I have?"
-   **Status Check**: "What is playing right now?"
-   **Management**: "Create a playlist called 'Sunday Vibes'".

### 2.2 Integration Pattern
-   **Source**: [vladimir-tutin/plex-mcp-server](https://github.com/vladimir-tutin/plex-mcp-server).
-   **Method**: Clone as a submodule (monorepo style) in `packages/plex-mcp-server`.
-   **Transport**: Stdio (spawned by `apps/agent`).

### 2.3 Dependencies
-   **Runtime**: Python 3.10+ (Required by `mcp` SDK).
-   ** Docker**:
    -   Must install `uv` (fast python package manager).
    -   Must create a virtual environment (`/opt/venv`).
    -   Must install `requirements.txt` from the cloned repo.

### 2.4 Configuration
-   **Env Vars**:
    -   `PLEX_URL`: Public or local URL of the Plex Server.
    -   `PLEX_TOKEN`: Authentication token.
-   **MCP Manager**:
    -   Must support `cwd` (Current Working Directory) to run the server content correctly.

## 3. Implementation Plan (Executed)
1.  **Clone**: `packages/plex-mcp-server`.
2.  **Core Update**: Modified `mcp-manager.js` to support `cwd` in config.
3.  **Config**: Added `plex` entry to `apps/agent/mcp_config.json`.
4.  **Docker**: Updated `Dockerfile` to install `uv` and build the python environment.

## 4. Verification
-   Build Docker container.
-   Check logs for `[MCP] Connecting to server: plex...`.
-   Verify `[MCP] Call tool: plex_library_get_contents` success.
