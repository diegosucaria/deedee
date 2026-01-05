const { BaseExecutor } = require('./base');

class MemoryExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { db, client } = this.services;
        const { message } = context;

        switch (name) {
            case 'searchMemory': {
                const results = db.searchMessages(args.query, args.limit || 10);
                return { results };
            }

            case 'consolidateMemory': {
                const date = args.date || new Date(Date.now() - 86400000).toISOString().split('T')[0];
                const messages = db.getMessagesByDate(date);

                if (!messages || messages.length === 0) {
                    return { info: `No messages found for ${date}.` };
                }

                // Summarize using Gemini Flash
                const modelName = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
                const logText = messages.map(m => `[${m.timestamp}] ${m.role}: ${m.content}`).join('\n');
                const summaryReq = `Summarize the following chat logs from ${date} into a concise bullet-point journal entry. Focus on what was achieved, facts learned, or tasks completed. Ignore trivial chatter.\n\nLogs:\n${logText}`;

                try {
                    const response = await client.models.generateContent({
                        model: modelName,
                        contents: [{ parts: [{ text: summaryReq }] }]
                    });

                    let summary = '';
                    if (response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
                        summary = response.candidates[0].content.parts.map(p => p.text).join(' ');
                    }

                    if (summary) {
                        this.services.journal.log(`## Daily Summary (${date})\n${summary}`);
                        return { success: true, summary_preview: summary.substring(0, 100) + '...' };
                    } else {
                        return { error: 'Failed to generate summary.' };
                    }
                } catch (err) {
                    return { error: `Consolidation failed: ${err.message}` };
                }
            }

            default: return null;
        }
    }
}

module.exports = { MemoryExecutor };
