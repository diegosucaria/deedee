const { BaseExecutor } = require('./base');

class RagExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { agent } = services;
        const ragService = agent.ragService; // We need to attach this to agent

        switch (name) {
            case 'searchDocuments': {
                if (!ragService) return { error: 'RAG Service not initialized.' };

                // Determine Vault Context
                const chatId = context.metadata?.chatId;
                const activeVault = chatId ? agent.activeTopics.get(chatId) : null;
                const vaultId = (activeVault && activeVault !== 'none') ? activeVault : null;

                const results = await ragService.search(args.query, vaultId);

                if (results.length === 0) return { info: 'No relevant documents found.' };

                const text = results.map(r => {
                    const typeLabel = r.content_type && r.content_type !== 'text' ? ` [${r.content_type.toUpperCase()}]` : '';
                    return `[Score: ${r.score.toFixed(2)}]${typeLabel} File: ${r.filename} (Vault: ${r.vault_id || 'Global'})\nContent: ${r.content}`;
                }).join('\n\n');
                return { results: text };
            }

            case 'ingestDocument': {
                if (!ragService) return { error: 'RAG Service not initialized.' };
                try {
                    await ragService.ingestDocument(args.path);
                    return { success: true, info: `Document indexed: ${args.path}` };
                } catch (e) {
                    return { error: `Ingestion failed: ${e.message}` };
                }
            }

            case 'reindexEmbeddings': {
                if (!ragService) return { error: 'RAG Service not initialized.' };
                try {
                    const vaultsDir = agent.vaults ? agent.vaults.vaultsDir : null;
                    const journalDir = agent.journal ? agent.journal.journalDir : null;
                    await ragService.reindexAll(vaultsDir, journalDir);
                    return { success: true, info: 'Full re-index complete. All documents re-embedded.' };
                } catch (e) {
                    return { error: `Re-index failed: ${e.message}` };
                }
            }

            default: return null;
        }
    }
}

module.exports = { RagExecutor };
