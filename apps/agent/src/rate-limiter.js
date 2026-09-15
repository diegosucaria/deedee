const { createAssistantMessage } = require('@deedee/shared/src/types');

// Internal sources: no count, no limit reply. Only human traffic is limited.
const INTERNAL_SOURCES = new Set(['scheduler', 'subagent', 'system']);

class RateLimiter {
    constructor(db) {
        this.db = db;
        this.limitHourly = parseInt(process.env.RATE_LIMIT_HOURLY || '50');
        this.limitDaily = parseInt(process.env.RATE_LIMIT_DAILY || '500');
    }

    static isInternal(message) {
        if (!message) return false;
        if (message.metadata?.isSubAgent) return true;
        if (INTERNAL_SOURCES.has(message.source)) return true;
        return String(message.content || '').startsWith('SYSTEM_WATCHER_ALERT');
    }

    async check(message, interfaceObj) {
        if (RateLimiter.isInternal(message)) return true;

        const usedHour = this.db.checkLimit(1);
        const usedDay = this.db.checkLimit(24);

        if (usedHour >= this.limitHourly || usedDay >= this.limitDaily) {
            console.warn(`[Agent] Rate limit exceeded. Hour: ${usedHour}/${this.limitHourly}, Day: ${usedDay}/${this.limitDaily}`);

            const limitReply = createAssistantMessage(`⚠️ Rate limit exceeded. please try again later.`);
            limitReply.metadata = { chatId: message.metadata?.chatId };
            limitReply.source = message.source;

            await interfaceObj.send(limitReply);
            return false; // Not allowed
        }

        this.db.logUsage();
        return true; // Allowed
    }
}

module.exports = { RateLimiter };
