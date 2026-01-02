const { createAssistantMessage } = require('@deedee/shared/src/types');

class RateLimiter {
    constructor(db) {
        this.db = db;
        this.limitHourly = parseInt(process.env.RATE_LIMIT_HOURLY || '50');
        this.limitDaily = parseInt(process.env.RATE_LIMIT_DAILY || '500');
    }

    async check(message, interfaceObj) {
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
