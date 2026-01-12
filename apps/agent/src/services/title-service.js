
const { ConfigService } = require('./config-service');
class TitleService {
    constructor(agent) {
        this.agent = agent;
        this.config = new ConfigService();
    }

    async autoTitleSession(chatId, context) {
        try {
            const prompt = `
            Generate a short, concise 3-4 word title for this chat session based on the user's first message:
            "${context}"
            
            Return ONLY the title. No quotes.
            `;

            const model = this.config.getModel('FLASH');

            const result = await this.agent.client.models.generateContent({
                model: model,
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            const title = result.text()?.trim();
            if (title) {
                this.agent.db.updateSessionTitle(chatId, title);
                console.log(`[TitleService] Set title for ${chatId}: "${title}"`);

                // Notify client to update UI
                await this.agent.interface.send({
                    source: 'web',
                    type: 'session_update',
                    content: JSON.stringify({ id: chatId, title }),
                    metadata: { chatId }
                });
            }
        } catch (e) {
            console.error(`[TitleService] Failed to auto-title ${chatId}:`, e);
            throw e; // Propagate for logging
        }
    }
}

module.exports = { TitleService };
