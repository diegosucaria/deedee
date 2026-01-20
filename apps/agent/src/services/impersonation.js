

class ImpersonationService {
    constructor(agent) {
        this.agent = agent;
        this.db = agent.db;
    }

    async generateDraft(chatId, incomingMessage, contactName) {
        console.log(`[Impersonation] Generating draft for chat ${chatId} from ${contactName}`);

        // 1. Fetch Context: User's recent messages in this chat
        // We want to mimic the user's style in THIS specific conversation if possible.
        // If not enough history, maybe fallback to global? For now, stick to chat history.
        const history = this.db.db.prepare(`
            SELECT content FROM messages 
            WHERE chat_id = ? AND role = 'user' AND content IS NOT NULL AND content != ''
            ORDER BY timestamp DESC LIMIT 20
        `).all(chatId).reverse();

        if (history.length < 3) {
            console.log('[Impersonation] Not enough history to impersonate style.');
            // Fallback: Just be helpful but warn? Or try generic?
            // We'll proceed with few examples.
        }

        const examples = history.map(m => `- ${m.content}`).join('\n');

        // 2. Build Prompt
        const prompt = `
You are an AI acting as the user "Diego". Your goal is to draft a reply to the incoming message that sounds EXACTLY like Diego.
Do not sound like a helpful AI. Sound like a human. 
Match his tone, brevity, lowercase/uppercase usage, and slang.

### Context (Diego's Past Messages in this chat):
${examples}

### Incoming Message from ${contactName}:
"${incomingMessage.content}"

### Instructions:
- Draft a reply in Diego's style.
- Keep it relevant to the conversation.
- If the incoming message is short, keep the reply short.
- Return ONLY the drafted reply text. No quotes.
- CRITICAL: maintain the same language as the incoming message.
`;

        // 3. Call LLM
        // Use the agent's configured model or a fast one.
        try {
            const response = await this.agent.client.models.generateContent({
                model: 'gemini-2.0-flash-exp', // Use fast model for drafting
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            const draftText = response.response.candidates[0].content.parts[0].text.trim();
            return draftText;
        } catch (error) {
            console.error('[Impersonation] Generation failed:', error);
            return null;
        }
    }
    /**
     * Get Autopilot status for a contact (by ID or Phone)
     */
    getAutopilotStatus(contactIdentifier, contactName) {
        if (!contactIdentifier) return 'off';

        // 1. Try finding person by ID directly
        let person = this.db.db.prepare('SELECT autopilot_status FROM people WHERE id = ?').get(contactIdentifier);

        // 2. If not found, try by phone/metadata match (simplistic for now, assuming contactIdentifier IS phone or ID)
        if (!person && contactIdentifier) {
            person = this.db.db.prepare('SELECT autopilot_status FROM people WHERE phone = ? OR id = ?').get(contactIdentifier, contactIdentifier);
        }

        // 3. Fallback: try fuzzier match if needed (not implemented yet)

        return person ? (person.autopilot_status || 'off') : 'off';
    }

    /**
     * Save a generated draft
     */
    saveDraft(chatId, contactId, content) {
        const stmt = this.db.db.prepare(`
            INSERT INTO autopilot_drafts (chat_id, contact_id, content, status)
            VALUES (?, ?, ?, 'pending')
        `);
        return stmt.run(chatId, contactId, content);
    }
}

module.exports = { ImpersonationService };
