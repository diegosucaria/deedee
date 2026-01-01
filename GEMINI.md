# Deedee - AI Developer Instructions

You are working on **Deedee**, a personal, self-improving AI agent designed to run on a Raspberry Pi.

## 🧠 Project Context
- **Goal**: A persistent agent that helps the user via chat (Telegram/Slack) and can interact with their digital life (Calendar, Files, Web).
- **Architecture**: Microservices in a Monorepo.
  - **Agent**: The brain (LangChain/Gemini). Unprivileged.
  - **Supervisor**: The immune system/updater. Privileged (Docker socket access).
  - **MCP Servers**: Tools exposed to the Agent.
- **Stack**: Node.js, Docker, Google Gemini, MCP (Model Context Protocol).

## 🛡️ Critical Mandates

### 1. Security First
- **Principle of Least Privilege**: The `Agent` container must NEVER have root access or direct Docker socket access. It must ask the `Supervisor` to perform system-level tasks.
- **Secrets**: Never hardcode API keys. Use environment variables.
- **Sandboxing**: Code execution (if added) must be strictly sandboxed.

### 2. TDD & Specs
- **Workflow**:
  1.  Read/Create a Spec file in `specs/`.
  2.  Write the Test first (Red).
  3.  Implement the Code (Green).
  4.  Refactor.
- **Do not skip tests.** The system is designed to be autonomous; tests are its guardrails.

### 3. Self-Improvement Philosophy
- The system should eventually be able to edit its own code.
- Always design interfaces with the idea: "How would the Agent call this to update itself?"

## 📂 Navigation
- **`TODO.md`**: The source of truth for current progress. Check this first.
- **`specs/`**: The detailed requirements for the current task.
- **`docs/architecture.md`**: The system map.

## 🚀 How to Resume Work
1. Read `TODO.md` to identify the current active task.
2. Check `specs/` for the corresponding requirement file.
3. Run `npm test` to see the current state of the codebase (and what is failing).
4. Continue the TDD cycle.
