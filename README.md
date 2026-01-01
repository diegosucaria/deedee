# Deedee: Personal AI Agent

Deedee is a secure, self-improving AI agent designed to run on a Raspberry Pi (or any Docker-capable host). It connects to your personal data (Google Workspace) and chat platforms (Telegram, Slack) to assist you.

## Architecture
See [docs/architecture.md](docs/architecture.md) for a detailed system overview.

## Directory Structure
- **apps/**
  - `agent`: The core AI logic (Node.js + LangChain/Gemini).
  - `supervisor`: Self-improvement and management service (privileged).
- **packages/**
  - `interfaces`: Adapters for Chat platforms (Telegram, Slack, etc.).
  - `mcp-servers`: Custom MCP tools (GSuite, Local System, Browser).
  - `shared`: Shared types and utilities.
- **infra/**: Docker Compose and deployment configuration.
- **specs/**: TDD Specifications.

## Getting Started

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Run Tests**
   ```bash
   npm test
   ```

3. **Development**
   Start by implementing the first spec: `specs/001-core-agent.md`.

## Security
This project follows a "Security First" approach.
- Secrets are not committed to git.
- The Supervisor is the only container with privileged access.
- All code changes should be spec'd and tested.
