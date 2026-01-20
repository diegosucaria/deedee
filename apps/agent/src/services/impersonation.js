const axios = require('axios');

class ImpersonationService {
    constructor(agent) {
        this.agent = agent;
        this.db = agent.db;
    }

    /**
     * Get the global style profile from settings
     */
    getStyleProfile() {
        const row = this.db.db.prepare("SELECT value FROM agent_settings WHERE key = 'user_style_profile'").get();
        if (!row) return null;
        try {
            return JSON.parse(row.value).profile;
        } catch (e) {
            return null;
        }
    }

    /**
     * Save the global style profile
     */
    saveStyleProfile(profileText) {
        const value = JSON.stringify({ profile: profileText });
        this.db.db.prepare(`
            INSERT INTO agent_settings (key, value, category) VALUES ('user_style_profile', ?, 'autopilot')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(value);
    }

    /**
     * Analyze global history to generate a style profile
     */

    async analyzeGlobalStyle() {
        console.log('[Impersonation] Analyzing global style...');

        // 1. Fetch from Interfaces (Real User History)
        let messages = [];
        try {
            // Internal URL for Interfaces Service
            const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
            const res = await axios.get(`${interfacesUrl}/whatsapp/global-history?limit=500`);
            messages = res.data;
        } catch (e) {
            console.error('[Impersonation] Failed to fetch history from Interfaces:', e.message);
            // Fallback to Agent DB if Interfaces fails (legacy behavior)
            messages = this.db.db.prepare(`
                SELECT content FROM messages 
                WHERE role = 'user' AND content IS NOT NULL AND content != ''
                ORDER BY timestamp DESC LIMIT 500
            `).all().reverse();
        }

        if (!messages || messages.length < 10) {
            return "Not enough history to analyze style.";
        }

        const corpus = messages.map(m => m.content).join('\n');

        // 2. Prompt Gemini
        const prompt = `
You are an expert linguist and ghostwriter. Analyze the following sample of messages sent by the user "Diego".
Create a "Style Profile" that describes EXACTLY how he writes.

Focus on:
- Tone (e.g., casual, dry, enthusiastic, direct)
- Formatting (capitalization, punctuation usage)
- Common slang or abbreviations
- Sentence structure complexity
- Language mixing (Does he mix English and Spanish?)

Sample:
"""
${corpus.substring(0, 30000)} 
"""
(Truncated to avoid token limits if necessary)

Output a concise, bulleted list of rules to follow to impersonate him perfectly. 
Do not be vague. Be prescriptive.
`;

        try {
            // PRO is better for deep analysis and nuance extraction
            const result = await this.agent.client.models.generateContent({
                model: process.env.WORKER_PRO || 'gemini-1.5-pro-exp',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            // Handle Response safely
            let profile = "";
            if (result.response && result.response.candidates && result.response.candidates.length > 0) {
                profile = result.response.candidates[0].content.parts[0].text.trim();
            } else if (result.candidates && result.candidates.length > 0) {
                // Fallback for different response structure
                profile = result.candidates[0].content.parts[0].text.trim();
            } else {
                throw new Error("No candidates in GenAI response");
            }

            this.saveStyleProfile(profile);
            return profile;
        } catch (e) {
            console.error('[Impersonation] Analysis failed:', e);
            throw e;
        }
    }

    async generateDraft(chatId, incomingMessage, contactName) {
        console.log(`[Impersonation] Generating draft for chat ${chatId} from ${contactName}`);

        // 1. Fetch Context: User's recent messages in this chat
        const history = this.db.db.prepare(`
            SELECT content FROM messages 
            WHERE chat_id = ? AND role = 'user' AND content IS NOT NULL AND content != ''
            ORDER BY timestamp DESC LIMIT 20
        `).all(chatId).reverse();

        const examples = history.map(m => `- ${m.content}`).join('\n');

        // 2. Fetch Global Style Profile
        const globalStyle = this.getStyleProfile();

        // 3. Build Prompt
        const prompt = `
You are an AI acting as the user "Diego". Your goal is to draft a reply to the incoming message that sounds EXACTLY like Diego.
Do not sound like a helpful AI. Sound like a human. 

${globalStyle ? `### GLOBAL STYLE GUIDE (Rules to Follow):\n${globalStyle}\n` : ''}

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

        // 4. Call LLM
        try {
            // PRO is better for deep analysis and nuance extraction
            const response = await this.agent.client.models.generateContent({
                model: process.env.WORKER_FLASH || 'gemini-1.5-pro-exp',
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
