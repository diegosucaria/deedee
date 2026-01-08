const { BaseExecutor } = require('./base');

class FileSystemExecutor extends BaseExecutor {
    async execute(name, args) {
        const { local } = this.services;

        switch (name) {
            case 'readFile': return await local.readFile(args.path);
            case 'writeFile': return await local.writeFile(args.path, args.content);
            case 'listDirectory': return await local.listDirectory(args.path);
            case 'runShellCommand': return await local.runShellCommand(args.command);
            default: return null;
        }
    }
}

module.exports = { FileSystemExecutor };
