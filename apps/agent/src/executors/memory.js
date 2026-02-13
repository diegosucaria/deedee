const { BaseExecutor } = require('./base');
const { getConsolidationPrompt } = require('../prompts/memory');

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
                const { agent } = this.services;
                const modelName = agent.configService.getModel('FLASH');
                const logText = messages.map(m => `[${m.timestamp}] ${m.role}: ${m.content}`).join('\n');

                const summaryReq = getConsolidationPrompt(date, logText);

                try {
                    const response = await client.models.generateContent({
                        model: modelName,
                        contents: [{ parts: [{ text: summaryReq }] }],
                        generationConfig: { responseMimeType: 'application/json' }
                    });

                    let data = null;
                    try {
                        const raw = response.candidates[0].content.parts.map(p => p.text).join(' ');
                        data = JSON.parse(raw);
                    } catch (e) {
                        // Fallback JSON extraction
                        // Sometimes model wraps in markdown code block
                        const raw = response.candidates[0].content.parts.map(p => p.text).join(' ');
                        const match = raw.match(/```json\n([\s\S]*?)\n```/) || raw.match(/{[\s\S]*}/);
                        if (match) data = JSON.parse(match[1] || match[0]);
                    }

                    if (data && data.summary) {
                        // 1. Log Journal
                        this.services.journal.log(`## Daily Summary (${date})\n${data.summary}`);

                        // 2. Save Facts to DB
                        let factsAdded = 0;
                        if (data.facts && Array.isArray(data.facts)) {
                            for (const f of data.facts) {
                                if (f.key && f.value) {
                                    db.setKey(f.key, f.value);
                                    factsAdded++;
                                }
                            }
                        }

                        // 3. Sync & Ingest
                        if (factsAdded > 0) {
                            const allFacts = db.getAllFacts();
                            const memoryPath = await this.services.journal.syncFactsToMemory(allFacts);
                            await agent.ragService.ingestDocument(memoryPath, 'memory');
                        }

                        return {
                            success: true,
                            summary_preview: data.summary.substring(0, 100) + '...',
                            facts_learned: factsAdded
                        };
                    } else {
                        return { error: 'Failed to generate valid summary JSON.' };
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
