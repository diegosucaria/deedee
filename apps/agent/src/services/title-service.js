
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

            let title = '';

            // Console Debug for Structure
            // console.log('[TitleService] Raw Result:', JSON.stringify(result, null, 2));

            // Robust Extraction
            try {
                if (typeof result.text === 'function') {
                    title = result.text();
                } else if (result.response && typeof result.response.text === 'function') {
                    title = result.response.text();
                }
            } catch (e) { /* ignore */ }

            if (!title) {
                // Fallback to parts
                const candidate = result.candidates?.[0] || result.response?.candidates?.[0];
                if (candidate?.content?.parts) {
                    title = candidate.content.parts.map(p => p.text).join('').trim();
                }
            }

            title = title?.trim();
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
