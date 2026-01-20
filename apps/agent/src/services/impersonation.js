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
            const headers = { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` };

            const res = await axios.get(`${interfacesUrl}/whatsapp/global-history?limit=500`, { headers });
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
                // SDK might return candidates directly if not using EnhancedResponse
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

    /**
     * Get style profile for a specific contact
     */
    getContactStyle(contactIdOrPhone) {
        // Try strict ID first, then phone match
        let person = this.db.getPerson(contactIdOrPhone);
        if (!person && contactIdOrPhone.includes('@')) {
            // It's a JID, try to find by phone (remove suffix)
            const phone = contactIdOrPhone.split('@')[0];
            // Fuzzy verify? or just try getPerson again if getPerson handles phone numbers (it does)
            person = this.db.getPerson(phone);
        }

        if (!person || !person.metadata) return null;
        try {
            const meta = JSON.parse(person.metadata);
            // Check for specific override or fallback
            return meta.style_profile || null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Save style profile for a specific contact
     */
    saveContactStyle(contactIdOrPhone, profileText) {
        let person = this.db.getPerson(contactIdOrPhone);

        // If searching by JID failed, try stripped phone
        if (!person && contactIdOrPhone.includes('@')) {
            person = this.db.getPerson(contactIdOrPhone.split('@')[0]);
        }

        if (!person) throw new Error("Person not found");

        let meta = {};
        try { meta = JSON.parse(person.metadata || '{}'); } catch (e) { }

        meta.style_profile = profileText;

        this.db.updatePerson(person.id, { metadata: JSON.stringify(meta) });
    }

    /**
     * Analyze style for a specific contact chat
     */
    async analyzeContactStyle(contactIdentifier) {
        console.log(`[Impersonation] Analyzing style for contact ${contactIdentifier}...`);

        // Resolve JID/Phone from Identifier (which could be UUID)
        let chatId = contactIdentifier;
        // Simple check if it's a UUID (no @, no spaces, length > 20)
        if (!chatId.includes('@') && chatId.length > 20) {
            const person = this.db.getPerson(contactIdentifier);
            if (person && person.phone) {
                chatId = person.phone;
                // Ensure JID format if it looks like a clean number (digits only, length 10-15)
                if (/^\d{10,15}$/.test(chatId)) {
                    chatId = `${chatId}@s.whatsapp.net`;
                }
            }
        }

        let corpus = "";
        try {
            // Internal URL for Interfaces Service
            const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
            const headers = { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` };

            const res = await axios.get(`${interfacesUrl}/whatsapp/history?jid=${encodeURIComponent(chatId)}&limit=100`, { headers });
            const messages = res.data.filter(m => m.role === 'user'); // Sent by me

            if (messages.length < 5) return "Not enough history with this contact.";
            corpus = messages.map(m => m.content).join('\n');

        } catch (e) {
            console.warn(`[Impersonation] Failed to fetch contact history for ${chatId} from Interfaces, falling back to local DB`, e.message);
            // Fallback: try searching by chatId or related people
            // Use contactIdentifier which might be the actual UUID in the DB
            const history = this.db.db.prepare(`
                SELECT content FROM messages 
                WHERE (chat_id = ? OR contact_id = ?) AND role = 'user' AND content IS NOT NULL AND content != ''
                ORDER BY timestamp DESC LIMIT 50
            `).all(chatId, contactIdentifier).reverse();
            corpus = history.map(m => m.content).join('\n');
        }

        if (!corpus || corpus.length < 50) return "Not enough history.";

        // 2. Prompt Gemini
        const prompt = `
You are an expert linguist. Analyze the following messages sent by "Diego" TO a specific contact.
Create a "Relationship Style Profile". How does Diego talk to THIS person specifically?

Focus on:
- Level of formality/intimacy
- Specific jargon or inside jokes (generalize patterns)
- Sentence length and enthusiasm compared to normal
- Language used (English/Spanish?)

Sample:
"""
${corpus}
"""

Output a concise list of rules for this specific relationship.
`;
        try {
            const result = await this.agent.client.models.generateContent({
                model: process.env.WORKER_PRO || 'gemini-1.5-pro-exp',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            let profile = "";
            if (result.response && result.response.candidates && result.response.candidates.length > 0) {
                profile = result.response.candidates[0].content.parts[0].text.trim();
            } else if (result.candidates && result.candidates.length > 0) {
                profile = result.candidates[0].content.parts[0].text.trim();
            } else {
                throw new Error("No candidates in GenAI response");
            }

            try {
                this.saveContactStyle(contactIdentifier, profile);
            } catch (saveErr) {
                console.warn("Could not save contact style (contact might not exist in people DB yet):", saveErr.message);
            }
            return profile;
        } catch (e) {
            console.error('[Impersonation] Contact Analysis failed:', e);
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

        // 2. Fetch Styles
        const globalStyle = this.getStyleProfile();
        const contactStyle = this.getContactStyle(chatId);

        // 3. Build Prompt
        const prompt = `
You are an AI acting as the user "Diego". Your goal is to draft a reply to the incoming message that sounds EXACTLY like Diego.
Do not sound like a helpful AI. Sound like a human. 

${globalStyle ? `### GLOBAL STYLE GUIDE (Baseline):\n${globalStyle}\n` : ''}

${contactStyle ? `### CONTACT-SPECIFIC STYLE (Override/Nuance for this person):\n${contactStyle}\n` : ''}

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
            const result = await this.agent.client.models.generateContent({
                model: process.env.WORKER_FLASH || 'gemini-2.0-flash-exp',
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            let draftText = "";
            if (result.response && result.response.candidates && result.response.candidates.length > 0) {
                draftText = result.response.candidates[0].content.parts[0].text.trim();
            } else if (result.candidates && result.candidates.length > 0) {
                draftText = result.candidates[0].content.parts[0].text.trim();
            } else {
                throw new Error("No candidates in GenAI response");
            }

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

        return person ? (person.autopilot_status || 'off') : 'off';
    }

    /**
     * Save a generated draft
     */
    saveDraft(chatId, contactId, content) {
        const stmt = this.db.db.prepare(`
            INSERT INTO autopilot_drafts(chat_id, contact_id, content, status)
            VALUES(?, ?, ?, 'pending')
        `);
        return stmt.run(chatId, contactId, content);
    }
}

module.exports = { ImpersonationService };
