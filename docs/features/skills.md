# Skills System

The Skills System allows Deedee to dynamically extend its capabilities using Markdown files.

## Architecture

*   **Definition**: Skills are defined in `data/skills/*.md` or built-in `apps/agent/skills/*.md`.
*   **Format**: Markdown with YAML frontmatter.
*   **Loading**: `SkillService` watches these directories and hot-reloads skills on change.
*   **Execution**: The Agent parses `instructions` and injects them into the System Prompt.

## Features

*   **Metadata**: Supports `emoji`, `description`, and `requires` (dependencies).
*   **Dependencies**: Can check for Environment Variables (`config`), MCP Tools (`tools`), or System Binaries (`bins`).
*   **Secrets**: Secrets (API Keys) are stored securely in `data/skills-state.json`. Manage them via the UI.
*   **Live Updates**: Changes to skill files or state are broadcasted to the Web UI via Socket.io.
*   **Context-Aware Injection**: Skills can be set to `injection: on-demand` so they are only injected into the system prompt when the user message matches relevant keywords. Default is `injection: always`.

## Creating a Skill

Create a file `data/skills/my-skill.md`:

```markdown
---
name: my-skill
description: Does something cool
injection: on-demand
metadata:
  emoji: 🚀
  requires:
    bins: [ffmpeg]
---

# Instructions

You can now do cool things...
```

### Injection Modes

| Value | Behavior |
|-------|----------|
| `always` (default) | Injected into every system prompt. Use for small, general-purpose skills. |
| `on-demand` | Only injected when the user message matches keywords from the skill's name and description. Use for large or domain-specific skills to save tokens and avoid conflicts. |

## API

*   `GET /v1/skills` - List skills
*   `POST /v1/skills/:name/toggle` - Enable/Disable
*   `POST /v1/skills/:name/secrets` - Set secrets

## Security

*   Secrets are stored in `data/skills-state.json`. Ensure this file is backed up and secure.
*   `user-invocable: false` prevents users from triggering the skill directly if needed.
