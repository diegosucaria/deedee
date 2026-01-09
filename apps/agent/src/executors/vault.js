const { BaseExecutor } = require('./base');
const path = require('path');

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
            case 'readVaultFile':
                return this.readVaultFile(args.topic, args.filename);
            case 'deleteVault':
                return this.deleteVault(args.topic);
            case 'setSessionTopic':
                return this.setSessionTopic(args.topic, context);
            case 'saveNoteToVault':
                return this.saveNoteToVault(args.topic, args.content, context);
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

    async deleteVault(topic) {
        await this.services.vaults.deleteVault(topic);
        return `Vault '${topic}' and all its contents have been permanently deleted.`;
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

    async saveNoteToVault(topic, content, context) {
        const date = new Date().toISOString().split('T')[0];
        const noteEntry = `\n\n## Note - ${date}\n${content}`;

        await this.services.vaults.appendVaultPage(topic, 'index.md', noteEntry);

        // Ensure context is switched (if not already)
        await this.setSessionTopic(topic, context);

        return `Note saved to '${topic}' vault.`;
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

    async readVaultFile(topic, filename) {
        try {
            const content = await this.services.vaults.readVaultFile(topic, filename);
            if (content === null) return `File '${filename}' not found in vault '${topic}'.`;
            return content;
        } catch (err) {
            return `Error reading file: ${err.message}`;
        }
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

module.exports = { VaultExecutor };
