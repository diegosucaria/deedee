const { getMemoryPruningPrompt } = require('../prompts/memory');
const { ConfigService } = require('./config-service');

// Guard rails for the LLM verdict. The judge runs on FLASH, so the code — not
// the prompt — decides what a single run may remove.
const DEFAULT_MAX_LLM_DELETES = 10;
const RECENT_DAYS = 7;

class MemoryPruningService {
    constructor(agent) {
        this.agent = agent;
        this._config = new ConfigService();
    }

    /** How many facts one LLM verdict may delete. MEMORY_PRUNE_MAX_DELETES overrides. */
    maxLlmDeletes() {
        const raw = process.env.MEMORY_PRUNE_MAX_DELETES;
        if (raw === undefined || raw === '') return DEFAULT_MAX_LLM_DELETES;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_LLM_DELETES;
    }

    /**
     * Facts the LLM may never delete, whatever it returns. Pinned facts, facts
     * the owner stated himself, preferences, and anything touched in the last
     * 7 days. Returns a reason string, or null when the fact may go.
     */
    _protectedReason(fact) {
        if (!fact) return null;
        if (fact.pinned) return 'pinned';
        if (String(fact.confidence || '').toLowerCase() === 'user_explicit') return 'confidence=user_explicit';
        const category = String(fact.category || '').toLowerCase();
        // The consolidation prompt writes 'preference'; older rows say 'preferences'.
        if (category === 'preference' || category === 'preferences') return `category=${category}`;
        if (category === 'relationship' || category === 'relationships') return `category=${category}`;

        const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
        for (const stamp of [fact.updated_at, fact.created_at]) {
            if (!stamp) continue;
            const t = new Date(stamp).getTime();
            if (Number.isFinite(t) && t >= cutoff) return `touched in the last ${RECENT_DAYS} days`;
        }
        return null;
    }

    /**
     * Analyze all facts and delete stale ones.
     */
    /**
     * Deterministic pre-filter: delete obviously stale facts without LLM.
     * Returns count of facts deleted.
     */
    _deterministicPrune(facts) {
        const now = new Date();
        const dateRegex = /_on_(\d{4}-\d{2}-\d{2})$/;
        let pruned = 0;
        const fs = require('fs');
        const path = require('path');
        const backupFile = path.join(this.agent.db.dbPath ? path.dirname(this.agent.db.dbPath) : path.join(process.cwd(), 'data'), 'pruned_memories.json');
        const timestamp = now.toISOString();
        const backupData = [];

        for (const f of facts) {
            if (f.pinned) continue;

            const dateMatch = f.key.match(dateRegex);
            if (!dateMatch) continue;

            const factDate = new Date(dateMatch[1] + 'T00:00:00');
            if (isNaN(factDate.getTime())) continue;

            const daysOld = Math.floor((now - factDate) / (1000 * 60 * 60 * 24));

            // Delete dated facts older than 5 days
            if (daysOld > 5) {
                backupData.push({ key: f.key, value: f.value, deletedAt: timestamp, reason: 'Deterministic: dated fact >5 days old' });
                this.agent.db.deleteFact(f.key);
                console.log(`[MemoryPruning] AUTO-DELETED (${daysOld}d old): ${f.key}`);
                pruned++;
            }
        }

        // Also delete notification flags (notified_*)
        for (const f of facts) {
            if (f.pinned) continue;
            if (f.key.startsWith('notified_') || f.key.startsWith('system_web_navigator_')) {
                backupData.push({ key: f.key, value: f.value, deletedAt: timestamp, reason: 'Deterministic: notification/system flag' });
                this.agent.db.deleteFact(f.key);
                console.log(`[MemoryPruning] AUTO-DELETED (flag): ${f.key}`);
                pruned++;
            }
        }

        // Backup deleted facts
        if (backupData.length > 0) {
            let currentBackup = [];
            try {
                if (fs.existsSync(backupFile)) {
                    currentBackup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
                }
            } catch (e) { /* ignore */ }
            currentBackup.push(...backupData);
            fs.writeFileSync(backupFile, JSON.stringify(currentBackup, null, 2));
            console.log(`[MemoryPruning] Deterministic pass: deleted ${pruned} facts, backed up to ${backupFile}`);
        }

        return pruned;
    }

    /** Tell the owner which keys the LLM verdict removed and where to find them. */
    _notifyPruned(keys, backupFile) {
        if (!keys.length || !this.agent?.notifications?.create) return;
        const shown = keys.slice(0, 10).join(', ');
        const rest = keys.length > 10 ? ` (+${keys.length - 10} more)` : '';
        try {
            this.agent.notifications.create({
                type: 'memory_pruned',
                severity: 'info',
                title: `Memory pruning removed ${keys.length} fact${keys.length === 1 ? '' : 's'}`,
                message: `Removed: ${shown}${rest}. Values are kept in ${backupFile} if you need them back.`,
                metadata: { keys, backupFile, link: '/system' }
            });
        } catch (e) {
            console.warn('[MemoryPruning] Failed to create prune notification:', e.message);
        }
    }

    async prune() {
        console.log('[MemoryPruning] Starting nightly prune...');

        // 1. Fetch all facts
        let facts = this.agent.db.getAllFacts();
        if (!facts || facts.length === 0) {
            console.log('[MemoryPruning] No facts to prune.');
            return { prunedCount: 0 };
        }

        // 1.5 Deterministic pre-filter: delete obviously stale dated facts and flags
        const autoPruned = this._deterministicPrune(facts);
        if (autoPruned > 0) {
            // Re-fetch after deterministic deletions
            facts = this.agent.db.getAllFacts();
        }

        // 2. Prepare Prompt (remaining facts go to LLM for judgment)
        const currentDate = new Date().toISOString().split('T')[0];
        const prompt = getMemoryPruningPrompt(facts, currentDate);

        // 3. Call LLM
        // FLASH: the verdict is bounded in code — the cap, the protected-fact
        // filter and the backup file all cover a wrong answer.
        const modelName = this.agent.configService.getModel('FLASH');

        try {
            const response = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ parts: [{ text: prompt }] }],
                config: { responseMimeType: 'application/json' }
            });

            this._config.logUsageFromResponse(this.agent.db, modelName, response, null, 'memory_pruning');

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

                const cap = this.maxLlmDeletes();
                const candidates = cap > 0 ? data.delete_keys.slice(0, cap) : [];
                if (data.delete_keys.length > candidates.length) {
                    console.warn(`[MemoryPruning] Verdict capped at ${candidates.length} of ${data.delete_keys.length} keys (MEMORY_PRUNE_MAX_DELETES).`);
                }

                for (const key of candidates) {
                    const exists = facts.find(f => f.key === key);
                    if (exists) {
                        // Safety: the code, not the prompt, decides what survives.
                        const protectedReason = this._protectedReason(exists);
                        if (protectedReason) {
                            console.warn(`[MemoryPruning] LLM tried to delete a protected fact: ${key} (${protectedReason}). Skipping.`);
                            continue;
                        }

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

                    // The job is silent, so without this the owner never learns
                    // a fact went. Keys only — values stay in the backup file.
                    this._notifyPruned(backupData.map(b => b.key), backupFile);
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
