const { createAssistantMessage } = require('@deedee/shared/src/types');

class SmartContextManager {
    constructor(db, client) {
        this.db = db;
        this.client = client;
        // Configuration
        this.TOKEN_THRESHOLD = parseInt(process.env.CONTEXT_TOKEN_THRESHOLD || '50000');
        this.SUMMARY_MODEL = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
    }

    /**
     * Main entry point to get context for a chat.
     * Checks if summarization is needed first.
     */
    async getContext(chatId, modelType = 'PRO') {
        // 1. Check if we need to summarize
        await this.checkAndSummarize(chatId);

        // 2. Fetch Latest Summary
        const summary = this.db.getLatestSummary(chatId);

        // 3. Fetch Recent History
        // If we have a summary, we only need recent messages since the summary.
        // If no summary, we fetch standard limit.
        const limit = modelType === 'FLASH' ? 20 : 50;

        // If summary exists, we might want to fetch fewer, or only those after summary.created_at?
        // Actually, db.getHistoryForChat creates a "sliding window". 
        // We should just fetch the limit. The summary acts as the "Long Term Memory" injection.

        const recentHistory = this.db.getHistoryForChat(chatId, limit);

        // 4. Inject Summary as System Message (or first user message)
        if (summary) {
            const summaryMsg = {
                role: 'user', // Inject as user to ensure model pays attention, or model 'system' if supported
                parts: [{
                    text: `
IMPORTANT CONTEXT SUMMARY:
The following is a compressed summary of our earlier conversation. Use it to maintain continuity.
--------------------------------------------------
${summary.content}
--------------------------------------------------
` }]
            };
            return [summaryMsg, ...recentHistory];
        }

        return recentHistory;
    }

    async checkAndSummarize(chatId) {
        // Simple Heuristic: If total messages > 50, or check token usage logs?
        // Better: Check raw text length of last 50 messages.
        // Fast estimation: 4 chars ~= 1 token.

        // Let's get "deep" history to see if it's huge.
        const deepHistory = this.db.getHistoryForChat(chatId, 100);
        if (deepHistory.length < 20) return; // Too short to summarize

        const estimatedTokens = JSON.stringify(deepHistory).length / 4;

        if (estimatedTokens > this.TOKEN_THRESHOLD) {
            console.log(`[SmartContext] Chat ${chatId} exceeds threshold (${Math.round(estimatedTokens)} tokens). Summarizing...`);
            await this.performSummarization(chatId, deepHistory);
        }
    }

    async performSummarization(chatId, history) {
        try {
            // Keep the last 10 messages intact (don't summarize them yet), summarize the older ones.
            const attemptsToSummarize = history.slice(0, history.length - 10);
            if (attemptsToSummarize.length < 5) return; // Not enough to summarize

            // Format for Flash
            const conversationText = attemptsToSummarize.map(m => `[${m.role.toUpperCase()}]: ${m.parts[0].text}`).join('\n');
            const prompt = `
            Compress the following conversation into a concise, high-level summary. 
            Focus on:
            1. What goals were accomplished?
            2. What key technical decisions were made?
            3. What is the current state of the system?
            4. Any specific file paths or variable names mentioned that are critical.
            
            CONVERSATION:
            ${conversationText}
            `;

            // Use independent session
            const model = this.client.getGenerativeModel({ model: this.SUMMARY_MODEL });
            const result = await model.generateContent(prompt);
            const summaryText = result.response.text();

            if (summaryText) {
                // Save Summary with real token usage
                const usage = result.response.usageMetadata;
                const originalTokens = usage?.promptTokenCount || 0;
                const summaryTokens = usage?.candidatesTokenCount || 0;

                const start = attemptsToSummarize[0].timestamp || new Date().toISOString();
                const end = attemptsToSummarize[attemptsToSummarize.length - 1].timestamp || new Date().toISOString();

                this.db.saveSummary(chatId, summaryText, start, end, originalTokens, summaryTokens);

                console.log(`[SmartContext] Summary created for ${chatId}. Compressed ${originalTokens} -> ${summaryTokens} tokens.`);
            }

        } catch (error) {
            console.error('[SmartContext] Summarization failed:', error);
        }
    }

    getStats() {
        const stats = this.db.getSummaryStats();
        // Specific metric: Real saved tokens
        const estimatedTokensSaved = stats.totalOriginal - stats.totalSummary;

        return {
            totalSummaries: stats.totalCount,
            estimatedTokensSaved
        };
    }

    getSummaries(limit) {
        return this.db.getSummaries(limit);
    }

    clearSummaries() {
        this.db.clearSummaries();
    }
}

module.exports = { SmartContextManager };
