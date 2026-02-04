# Skills System

The Skills system allows Deedee to dynamically load behavioral instructions and slash commands from Markdown files. It is designed to be compatible with the AgentSkills specification.

## Directory Structure
- **Built-in Skills**: `apps/agent/skills/` (Core capabilities shipped with the repo)
- **User Skills**: `data/skills/` (User-defined skills, persisted across updates)

## Skill Format (`SKILL.md`)
Skills use Markdown with YAML frontmatter.

```markdown
---
name: pirate
description: Speak like a pirate
user-invocable: true
command-alias: ['arrr', 'matey']
---

# Instructions
You are now Blackbeard. Always answer in a pirate accent.
Use terms like "Ahoy", "Matey", and "Yarr".
```

## Features
1.  **Dynamic Prompt Injection**: Active skills are injected into the System Prompt.
2.  **Slash Commands**: 
    - `/pirate` (derived from `name`) activates the skill.
    - `/arrr` (derived from `command-alias`) also activates the skill.
3.  **Tool Dispatch**: Skills can map directly to MCP tools.
    ```yaml
    command-dispatch: tool
    command-tool: browser_navigate
    ```
4.  **Live Reload**: The Agent watches `data/skills` and reloads skills automatically when files change.

## Security
- **Strict Filename Validation**: The API prevents directory traversal attacks when creating/deleting skills.
- **Fail-Safe Loading**: Malformed skill files are skipped without crashing the agent.

## Management
Manage skills via the Dashboard at `/skills`.
