const { exec } = require('child_process');

async function executeShellCommand(args) {
    const { command } = args;

    if (!command) {
        throw new Error('Command is required');
    }

    console.log(`[MacShell] Executing: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, { shell: '/bin/zsh' }, (error, stdout, stderr) => {
            if (error) {
                // We return output even on error because stderr might be useful
                return resolve({
                    content: [
                        { type: 'text', text: `Error: ${error.message}\nStderr: ${stderr}\nStdout: ${stdout}` }
                    ],
                    isError: true
                });
            }

            resolve({
                content: [
                    { type: 'text', text: stdout || stderr || '(No output)' }
                ]
            });
        });
    });
}

const macShellTool = {
    name: "mac_shell",
    description: "Execute a shell command on the host macOS machine. Use with CAUTION. You have access to zsh.",
    inputSchema: { // MCP Format
        type: "object",
        properties: {
            command: {
                type: "string",
                description: "The shell command to execute"
            }
        },
        required: ["command"]
    },
    handler: executeShellCommand
};

module.exports = { macShellTool };
