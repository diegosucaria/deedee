const axios = require('axios');
const { BaseExecutor } = require('./base');

class FileSystemExecutor extends BaseExecutor {
    constructor(services) {
        super(services);
        this.supervisorUrl = process.env.SUPERVISOR_URL || 'http://supervisor:4000';
    }

    async _callSupervisor(command, data = {}) {
        try {
            const response = await axios.post(`${this.supervisorUrl}/cmd/${command}`, data, {
                headers: {
                    'x-supervisor-token': process.env.SUPERVISOR_TOKEN
                }
            });
            return JSON.stringify(response.data);
        } catch (error) {
            return `Error calling supervisor: ${error.message} - ${error.response?.data?.error || ''}`;
        }
    }

    async execute(name, args) {
        const { local } = this.services;

        switch (name) {
            case 'readFile': return await local.readFile(args.path);
            case 'writeFile': return await local.writeFile(args.path, args.content);
            case 'listDirectory': return await local.listDirectory(args.path);
            case 'runShellCommand': {
                const opts = {};
                if (typeof args.timeoutMs === 'number' && args.timeoutMs > 0) {
                    opts.timeout = Math.min(args.timeoutMs, 300000);
                }
                return await local.runShellCommand(args.command, opts);
            }

            // Git Ops via Supervisor
            case 'commitAndPush':
                return await this._callSupervisor('commit', { message: args.message });
            case 'rollbackLastChange':
                return await this._callSupervisor('rollback');
            case 'pullLatestChanges':
                return await this._callSupervisor('pull');

            default: return null;
        }
    }
}

module.exports = { FileSystemExecutor };
