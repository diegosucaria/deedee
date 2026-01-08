const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

class PeopleService {
    constructor(agent) {
        this.agent = agent;
        this.interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
    }

    async suggestPeopleFromHistory() {
        const existingPeople = this.agent.db.listPeople();
        const existingPhones = new Set(existingPeople.map(p => {
            // Extract phone from ID or phone field
            // ID logic often uses phone. Check DB implementation.
            // If ID is UUID, check phone field.
            return p.phone ? p.phone.replace(/\D/g, '') : null;
        }).filter(Boolean));

        // 1. Fetch Recent Chats (User session preferred for mirroring real phone)
        const recentRes = await axios.get(`${this.interfacesUrl}/whatsapp/recent`, {
            params: { session: 'user', limit: 20 },
            headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
        });
        const recentChats = recentRes.data || [];

        const candidates = [];

        // 2. Filter & Gather Context
        for (const chat of recentChats) {
            const phone = chat.jid.split('@')[0];
            if (existingPhones.has(phone)) continue;

            // Fetch History
            try {
                const historyRes = await axios.get(`${this.interfacesUrl}/whatsapp/history`, {
                    params: { session: 'user', jid: chat.jid, limit: 50 },
                    headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
                });
                const messages = historyRes.data || [];

                if (messages.length < 5) continue; // Not enough context

                candidates.push({
                    jid: chat.jid,
                    phone,
                    messages: messages
                });
            } catch (e) {
                console.warn(`[People] Failed to fetch history for ${chat.jid}:`, e.message);
            }
        }

        if (candidates.length === 0) return [];

        // 3. LLM Analysis
        const analysis = await this._analyzeCandidates(candidates);
        return analysis;
    }

    async _analyzeCandidates(candidates) {
        if (!this.agent.client) return [];

        // Batch analysis or single? Batch is cheaper but context heavy.
        // Let's do top 5 candidates max to save context.
        const topCandidates = candidates.slice(0, 5);

        let prompt = `You are a helpful assistant managing my contacts.
Analyze the following conversation snippets from WhatsApp and suggest which people I should add to my contacts.
For each person, infer their name, my relationship to them, and a summary of why you think so.
Only suggest people who seem to be personal contacts (friends, family, colleagues, service providers). Ignore spam or strictly transactional bots.

Existing Contacts: (Already filtered out)

Candidates:
`;

        for (const c of topCandidates) {
            const transcript = c.messages.map(m => `${m.role === 'assistant' ? 'Me' : 'Them'}: ${m.content}`).join('\n');
            prompt += `\n--- Candidate Phone: ${c.phone} ---\n${transcript.substring(0, 2000)}\n`; // Cap context per person
        }

        prompt += `\n
Return a JSON array of objects with this schema:
{
  "phone": "extracted phone",
  "suggestedName": "Inferred Name",
  "relationship": "Friend | Mother | Plumber etc",
  "reason": "Brief explanation",
  "confidence": 0-1
}
Output pure JSON only.`;

        try {
            const modelName = process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
            const response = await this.agent.client.models.generateContent({
                model: modelName,
                contents: prompt
            });

            // Robust Response Handling (matching agent.js / helpers.js)
            const candidate = response.candidates?.[0];
            const part = candidate?.content?.parts?.[0];
            const text = part?.text || '';

            if (!text) {
                throw new Error('No text returned from model');
            }

            // Extract JSON
            const jsonMatch = text.match(/\[.*\]/s);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                // Merge with JIDs
                return data.map(d => ({
                    ...d,
                    id: d.phone, // Temporary ID
                    jid: `${d.phone}@s.whatsapp.net` // Heuristic
                }));
            }
        } catch (e) {
            console.error('[People] LLM Analysis failed:', e);
        }
        return [];
    }

    // --- Profile Pictures ---

    async cacheAvatar(personId, jid) {
        if (!jid) return null;

        try {
            // 1. Get URL
            const res = await axios.get(`${this.interfacesUrl}/whatsapp/profile`, {
                params: { session: 'user', jid },
                headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
            });
            const url = res.data.url;
            if (!url) return null;

            // 2. Download
            const avatarsDir = path.join(process.cwd(), 'data', 'avatars');
            if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

            const dest = path.join(avatarsDir, `${personId}.jpg`);

            await this._downloadImage(url, dest);
            return `/avatars/${personId}.jpg`; // Public path

        } catch (e) {
            console.error(`[People] Avatar cache failed for ${personId}:`, e.message);
            return null;
        }
    }

    _downloadImage(url, dest) {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, (response) => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close(resolve);
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => reject(err));
            });
        });
    }
}

module.exports = { PeopleService };
