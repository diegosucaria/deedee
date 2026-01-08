const { FileSystemExecutor } = require('./executors/filesystem');
const { MemoryExecutor } = require('./executors/memory');
const { ProductivityExecutor } = require('./executors/productivity');
const { SmartHomeExecutor } = require('./executors/smarthome');
const { SchedulerExecutor } = require('./executors/scheduler');
const { GSuiteExecutor } = require('./executors/gsuite');
const { MediaExecutor } = require('./executors/media');
const { CommunicationExecutor } = require('./executors/communication');
const { VaultExecutor } = require('./executors/vault');
const { PeopleExecutor } = require('./executors/people');

class ToolExecutor {
    /**
     * @param {Object} services - The services available to the agent
     */
    constructor(services) {
        this.services = services;
        this.executors = [
            new FileSystemExecutor(services),
            new MemoryExecutor(services),
            new VaultExecutor(services), // Add Vault Executor
            new ProductivityExecutor(services),
            new SmartHomeExecutor(services),
            new SchedulerExecutor(services),
            new GSuiteExecutor(services),
            new MediaExecutor(services),
            new CommunicationExecutor(services),
            new PeopleExecutor(services)
        ];
    }

    /**
     * Execute a tool by name
     */
    async execute(name, args, context) {
        // Try all registered executors
        for (const executor of this.executors) {
            const result = await executor.execute(name, args, context);
            if (result !== null) {
                return result;
            }
        }

        // Fallback to MCP
        try {
            return await this.services.mcp.callTool(name, args);
        } catch (e) {
            throw e;
        }
    }
}

module.exports = { ToolExecutor };
