const fs = require('fs/promises');
const path = require('path');

class VaultManager {
    constructor(dataDir) {
        this.vaultsDir = path.join(dataDir, 'vaults');
    }

    async initialize() {
        await fs.mkdir(this.vaultsDir, { recursive: true });
        // Ensure default vaults exist
        await this.createVault('health');
        await this.createVault('finance');
    }

    async listVaults() {
        try {
            const entries = await fs.readdir(this.vaultsDir, { withFileTypes: true });
            const vaults = await Promise.all(entries
                .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
                .map(async dirent => {
                    const stats = await this.getVaultStats(dirent.name);
                    return {
                        id: dirent.name,
                        name: dirent.name.charAt(0).toUpperCase() + dirent.name.slice(1),
                        ...stats
                    };
                }));
            return vaults;
        } catch (error) {
            console.error('Error listing vaults:', error);
            return [];
        }
    }

    async getVaultStats(topic) {
        const vaultPath = path.join(this.vaultsDir, topic);
        const filesPath = path.join(vaultPath, 'files');
        let fileCount = 0;
        let lastModified = null;

        try {
            await fs.access(filesPath);
            const files = await fs.readdir(filesPath);
            fileCount = files.length;

            const stats = await fs.stat(vaultPath);
            lastModified = stats.mtime;
        } catch (e) {
            // Ignore if files dir doesn't exist
        }

        return { filesCount: fileCount, lastModified };
    }

    async createVault(topic) {
        const safeTopic = this.sanitizeTopic(topic);
        const vaultPath = path.join(this.vaultsDir, safeTopic);
        const filesPath = path.join(vaultPath, 'files');
        const indexPath = path.join(vaultPath, 'index.md');

        await fs.mkdir(filesPath, { recursive: true });

        try {
            await fs.access(indexPath);
        } catch {
            await fs.writeFile(indexPath, `# ${safeTopic.charAt(0).toUpperCase() + safeTopic.slice(1)} Vault\n\nActive context for ${safeTopic}.`);
        }

        return safeTopic;
    }

    async deleteVault(topic) {
        const safeTopic = this.sanitizeTopic(topic);
        const vaultPath = path.join(this.vaultsDir, safeTopic);

        try {
            await fs.access(vaultPath);
            await fs.rm(vaultPath, { recursive: true, force: true });
            return true;
        } catch (error) {
            // If it doesn't exist, technically it's already "deleted", but let's throw if needed?
            // "force: true" in rm handles non-existence usually, but access check is safer for logic.
            // If access fails, it doesn't exist.
            if (error.code === 'ENOENT') {
                throw new Error(`Vault '${safeTopic}' does not exist.`);
            }
            throw error;
        }
    }

    async addToVault(topic, sourcePath, filename) {
        const safeTopic = this.sanitizeTopic(topic);
        const safeFilename = path.basename(filename); // Ensure no path traversal
        const targetPath = path.join(this.vaultsDir, safeTopic, 'files', safeFilename);
        const vaultPath = path.join(this.vaultsDir, safeTopic);

        // Validate vault exists
        try {
            await fs.access(vaultPath);
        } catch {
            throw new Error(`Vault '${safeTopic}' does not exist.`);
        }

        // Ensure files directory exists
        await fs.mkdir(path.join(vaultPath, 'files'), { recursive: true });

        await fs.copyFile(sourcePath, targetPath);
        return targetPath;
    }

    async readVaultPage(topic, pageName = 'index.md') {
        const safeTopic = this.sanitizeTopic(topic);
        const safePage = path.basename(pageName);
        if (!safePage.endsWith('.md')) throw new Error("Only .md files allowed");

        const filePath = path.join(this.vaultsDir, safeTopic, safePage);
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return content;
        } catch (error) {
            return null;
        }
    }

    async updateVaultPage(topic, pageName, content) {
        const safeTopic = this.sanitizeTopic(topic);
        const safePage = path.basename(pageName);
        if (!safePage.endsWith('.md')) throw new Error("Only .md files allowed");

        const filePath = path.join(this.vaultsDir, safeTopic, safePage);
        await fs.writeFile(filePath, content, 'utf-8');
        return true;
    }

    async appendVaultPage(topic, pageName, content) {
        const safeTopic = this.sanitizeTopic(topic);
        const safePage = path.basename(pageName);
        if (!safePage.endsWith('.md')) throw new Error("Only .md files allowed");

        const filePath = path.join(this.vaultsDir, safeTopic, safePage);

        // Check availability
        try {
            await fs.access(filePath);
        } catch {
            await fs.writeFile(filePath, `# ${safeTopic.charAt(0).toUpperCase() + safeTopic.slice(1)} Vault\n`);
        }

        await fs.appendFile(filePath, content, 'utf-8');
        return true;
    }

    async listVaultPages(topic) {
        const safeTopic = this.sanitizeTopic(topic);
        const vaultPath = path.join(this.vaultsDir, safeTopic);
        try {
            const entries = await fs.readdir(vaultPath, { withFileTypes: true });
            return entries
                .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== 'index.md')
                .map(e => e.name);
        } catch {
            return [];
        }
    }

    async listVaultFiles(topic) {
        const safeTopic = this.sanitizeTopic(topic);
        const filesPath = path.join(this.vaultsDir, safeTopic, 'files');
        try {
            const files = await fs.readdir(filesPath);
            return files;
        } catch {
            return [];
        }
    }

    async readVaultFile(topic, filename) {
        const safeTopic = this.sanitizeTopic(topic);
        const safeFilename = path.basename(filename); // Prevent traversal
        const filePath = path.join(this.vaultsDir, safeTopic, 'files', safeFilename);

        try {
            // Check if file exists first
            await fs.access(filePath);
            const content = await fs.readFile(filePath, 'utf-8'); // Assuming text files for now?
            // TODO: Handle binary files (PDF/Image) — currently assumes text via utf-8
            return content;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async deleteVaultFile(topic, filename) {
        const safeTopic = this.sanitizeTopic(topic);
        const safeFilename = path.basename(filename);
        const filePath = path.join(this.vaultsDir, safeTopic, 'files', safeFilename);

        try {
            await fs.access(filePath);
            await fs.unlink(filePath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error(`File '${safeFilename}' not found in vault '${safeTopic}'.`);
            }
            throw error;
        }
    }

    sanitizeTopic(topic) {
        return topic.toLowerCase()
            .replace(/\s+/g, '-') // Replace spaces with dashes
            .replace(/[^a-z0-9_-]/g, ''); // Remove invalid chars
    }
}

module.exports = VaultManager;
