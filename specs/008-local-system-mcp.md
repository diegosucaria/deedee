# Spec 008: Local System MCP

## Objective
Provide the Agent with direct access to the local file system and shell to perform tasks like code editing, file management, and system exploration.

## Components

### 1. Local Tools (`packages/mcp-servers/src/local/index.js`)
- **Library**: Built-in `fs` and `child_process`.
- **Tools Exposed**:
    1.  `read_file(path)`
    2.  `write_file(path, content)`
    3.  `list_directory(path)`
    4.  `run_shell_command(command)`

### 2. Security Constraints
- **Command Whitelist**: A broad list of allowed binaries to prevent hanging processes (interactive tools).
    - Allowed: `ls`, `cat`, `grep`, `find`, `git`, `npm`, `node`, `curl`, `rm`, `mv`, `cp`, `mkdir`, `touch`.
    - Blocked: `vi`, `nano`, `top`, `less` (anything requiring TTY input).
- **Timeouts**: All commands must have a timeout (e.g., 30s) to prevent freezing the Agent.

## Scenario: "List files in my project"

**Given** the Agent receives "What files are in the source folder?".
**When** the Agent calls `run_shell_command('ls -la /app/source')`.
**Then** the tool should return the standard output of the command.

## Scenario: "Create a new script"

**Given** the Agent wants to create a utility script.
**When** the Agent calls `write_file('/app/source/scripts/hello.js', 'console.log("hi")')`.
**Then** the file should be created.

## Implementation Plan
1. Create `packages/mcp-servers/src/local/index.js`.
2. Update `apps/agent/src/agent.js` to register the Local Tools.
3. Create test `packages/mcp-servers/tests/local.test.js`.
