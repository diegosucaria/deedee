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
                const { agent } = this.services;
                const modelName = agent.configService.getModel('FLASH');
                const logText = messages.map(m => `[${m.timestamp}] ${m.role}: ${m.content}`).join('\n');

                const summaryReq = `You are a Memory Consolidation System.
                Analyze the following chat logs from ${date}.
                
                Produce a JSON object with two fields:
                1. "summary": A concise bullet-point journal entry of what happened, tasks completed, and context.
                2. "facts": An array of { key, value } objects representing NEW durable facts, preferences, or critical information learned about the user.
                   - Keys should be snake_case (e.g. user_project_name, favorite_color).
                   - Values should be concise strings.
                   - STRICTLY EXCLUDE:
                     - Information derived purely from transcripts, YouTube summaries, or web scrapes (unless the user explicitly confirms or claims it).
                     - General world knowledge or trivia (e.g. "Spaceships use fuel X").
                     - Temporary context (e.g. "User is currently looking at file Y").
                   - INCLUDE ONLY:
                     - User preferences (diet, tools, workflow).
                     - User relationships (names, roles).
                     - Long-term project states or goals.
                     - Explicit instructions ("Remember that I...").
                
                Logs:
                ${logText}`;

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
