const { getMemoryPruningPrompt } = require('../prompts/memory');

class MemoryPruningService {
    constructor(agent) {
        this.agent = agent;
    }

    /**
     * Analyze all facts and delete stale ones.
     */
    async prune() {
        console.log('[MemoryPruning] Starting nightly prune...');

        // 1. Fetch all facts
        const facts = this.agent.db.getAllFacts();
        if (!facts || facts.length === 0) {
            console.log('[MemoryPruning] No facts to prune.');
            return { prunedCount: 0 };
        }

        // 2. Prepare Prompt
        const currentDate = new Date().toISOString().split('T')[0];
        const prompt = getMemoryPruningPrompt(facts, currentDate);

        // 3. Call LLM 
        const modelName = this.agent.configService.getModel('PRO');

        try {
            const response = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ parts: [{ text: prompt }] }],
                config: { responseMimeType: 'application/json' }
            });

            // 4. Parse Response
            let data = null;
            try {
                // In @google/genai, output is slightly different
                const raw = response.candidates[0].content.parts[0].text;
                // Handle potential markdown wrapping
                const jsonStr = raw.replace(/```json\n|\n```/g, '').trim();
                data = JSON.parse(jsonStr);
            } catch (e) {
                console.error('[MemoryPruning] Failed to parse LLM response:', e);
                return { error: 'Parse Error' };
            }

            // 5. Execute Deletions
            let prunedCount = 0;
            if (data && data.delete_keys && Array.isArray(data.delete_keys)) {
                console.log(`[MemoryPruning] LLM identified ${data.delete_keys.length} candidates for deletion.`);

                // Backup Loop
                const backupData = [];
                const timestamp = new Date().toISOString();

                for (const key of data.delete_keys) {
                    // Double check key exists to be safe
                    const exists = facts.find(f => f.key === key);
                    if (exists) {
                        backupData.push({
                            key,
                            value: exists.value,
                            deletedAt: timestamp,
                            reason: 'LLM Pruning'
                        });

                        this.agent.db.deleteFact(key);
                        console.log(`[MemoryPruning] DELETED: ${key} (Value: ${JSON.stringify(exists.value).substring(0, 50)}...)`);
                        prunedCount++;
                    } else {
                        console.warn(`[MemoryPruning] LLM suggested deleting non-existent key: ${key}`);
                    }
                }

                // Append to Backup File
                if (backupData.length > 0) {
                    const fs = require('fs');
                    const path = require('path');
                    const backupFile = path.join(this.agent.db.dbPath ? path.dirname(this.agent.db.dbPath) : path.join(process.cwd(), 'data'), 'pruned_memories.json');

                    let currentBackup = [];
                    try {
                        if (fs.existsSync(backupFile)) {
                            currentBackup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
                        }
                    } catch (e) {
                        console.warn('[MemoryPruning] Failed to read existing backup, creating new one.');
                    }

                    currentBackup.push(...backupData);
                    fs.writeFileSync(backupFile, JSON.stringify(currentBackup, null, 2));
                    console.log(`[MemoryPruning] Backed up ${backupData.length} items to ${backupFile}`);
                }
            }

            // 6. Sync if changes made
            if (prunedCount > 0) {
                console.log(`[MemoryPruning] Syncing updated memory to disk/RAG...`);
                const allFacts = this.agent.db.getAllFacts();
                const memoryPath = await this.agent.journal.syncFactsToMemory(allFacts);
                await this.agent.ragService.ingestDocument(memoryPath, 'memory');
            }

            console.log(`[MemoryPruning] Finished. Removed ${prunedCount} facts.`);
            return { prunedCount };

        } catch (err) {
            console.error('[MemoryPruning] Execution failed:', err);
            return { error: err.message };
        }
    }
}

module.exports = { MemoryPruningService };
