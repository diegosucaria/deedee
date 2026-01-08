const { BaseExecutor } = require('./base');

class VaultExecutor extends BaseExecutor {
    constructor(services) {
        super(services);
    }

    async execute(name, args, context) {
        switch (name) {
            case 'createVault':
                return this.createVault(args.topic);
            case 'listVaults':
                return this.listVaults();
            case 'addToVault':
                return this.addToVault(args.topic, args.file_path, args.summary, context);
            case 'readVaultPage':
                return this.readVaultPage(args.topic, args.page);
            case 'updateVaultPage':
                return this.updateVaultPage(args.topic, args.page, args.content);
            case 'listVaultFiles':
                return this.listVaultFiles(args.topic);
            case 'setSessionTopic':
                return this.setSessionTopic(args.topic, context);
            default:
                return null;
        }
    }

    async createVault(topic) {
        const id = await this.services.vaults.createVault(topic);
        return `Vault '${id}' created successfully.`;
    }

    async listVaults() {
        const vaults = await this.services.vaults.listVaults();
        return JSON.stringify(vaults, null, 2);
    }

    async addToVault(topic, filePath, summary, context) {
        // 1. Move file
        const targetPath = await this.services.vaults.addToVault(topic, filePath, filePath);

        // 2. Append to index.md (Wiki)
        const currentWiki = await this.services.vaults.readVaultPage(topic, 'index.md') || `# ${topic} Vault\n`;
        const date = new Date().toISOString().split('T')[0];
        const newWiki = `${currentWiki}\n\n## Added on ${date}\n- **File**: ${path.basename(targetPath)}\n- **Summary**: ${summary}`;
        await this.services.vaults.updateVaultPage(topic, 'index.md', newWiki);

        // 3. Switch Context (Magical Part)
        await this.setSessionTopic(topic, context);

        return `File saved to ${targetPath}. Vault index updated. Context switched to '${topic}'.`;
    }

    async readVaultPage(topic, page) {
        const content = await this.services.vaults.readVaultPage(topic, page);
        if (!content) return `Page '${page}' not found in vault '${topic}'.`;
        return content;
    }

    async updateVaultPage(topic, page, content) {
        await this.services.vaults.updateVaultPage(topic, page, content);
        return `Page '${page}' updated in vault '${topic}'.`;
    }

    async listVaultFiles(topic) {
        const files = await this.services.vaults.listVaultFiles(topic);
        return JSON.stringify(files);
    }

    async setSessionTopic(topic, context) {
        const chatId = context.metadata?.chatId;
        if (!chatId) {
            return "Context switching failed: No active chatId found.";
        }

        // Update the active topic in the Agent's memory
        this.services.agent.activeTopics.set(chatId, topic);
        return `Session topic switched to '${topic}'. System instructions will update on next turn.`;
    }
}

const path = require('path');

module.exports = { VaultExecutor };
