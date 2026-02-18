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
                // Cache for contact names to avoid repeated DB lookups
                const contactCache = new Map();

                const logText = messages.map(m => {
                    let sender = m.role;

                    // If it's a user message, try to resolve the name
                    if (m.role === 'user' && m.metadata) {
                        try {
                            const meta = JSON.parse(m.metadata);
                            const phone = meta.phoneNumber || meta.contactId;

                            if (phone) {
                                if (!contactCache.has(phone)) {
                                    // Try to resolve name
                                    const person = db.getPerson(phone);
                                    if (person && person.name) {
                                        contactCache.set(phone, `${person.name} (${phone})`);
                                    } else {
                                        // Fallback to pushname/notify if available in meta? Use raw phone
                                        contactCache.set(phone, phone);
                                    }
                                }
                                sender = contactCache.get(phone);
                            }
                        } catch (e) {
                            // ignore metadata parse error
                        }
                    } else if (m.role === 'model' || m.role === 'assistant') {
                        sender = 'Me (Agent)';
                    }


                    return `[${m.timestamp}] ${sender}: ${m.content}`;
                }).join('\n');

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

                        const summaryStr = typeof data.summary === 'string' ? data.summary : String(data.summary);
                        return {
                            success: true,
                            summary_preview: summaryStr.substring(0, 100) + '...',
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
