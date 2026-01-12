const { BaseExecutor } = require('./base');

class RagExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { agent } = this.services;
        const ragService = agent.ragService; // We need to attach this to agent

        switch (name) {
            case 'searchDocuments': {
                if (!ragService) return { error: 'RAG Service not initialized.' };
                const results = await ragService.search(args.query);

                if (results.length === 0) return { info: 'No relevant documents found.' };

                const text = results.map(r => `[Score: ${r.score.toFixed(2)}] File: ${r.filename}\nContent: ${r.content}`).join('\n\n');
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

            default: return null;
        }
    }
}

module.exports = { RagExecutor };
