const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');

class PeopleService {
    constructor(agent) {
        this.agent = agent;
        this.interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
    }

    async suggestPeopleFromHistory({ limit = 5, offset = 0 } = {}) {
        // 0. Build exclusion set from DB (Phone + Identifiers)
        const existingPeople = this.agent.db.listPeople();
        const existingIdentifiers = new Set();

        for (const p of existingPeople) {
            if (p.phone) existingIdentifiers.add(p.phone.replace(/\D/g, ''));
            // Check identifiers JSON
            if (p.identifiers) {
                Object.values(p.identifiers).forEach(val => {
                    if (typeof val === 'string') existingIdentifiers.add(val.replace(/\D/g, ''));
                });
            }
        }

        // 1. Fetch Recent Chats (Fetch ample amount to handle filtering and pagination)
        // We fetch (offset + limit * 3) to ensure we have enough candidates after filtering
        // This is a heuristic.
        const fetchLimit = (offset + limit) * 4;

        const recentRes = await axios.get(`${this.interfacesUrl}/whatsapp/recent`, {
            params: { session: 'user', limit: fetchLimit },
            headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
        });
        const recentChats = recentRes.data || [];

        const candidates = [];
        let skipped = 0;

        // 2. Filter & Gather Context
        for (const chat of recentChats) {
            const phone = chat.jid.split('@')[0];

            // Skip existing contacts
            if (existingIdentifiers.has(phone)) continue;

            // Skip if we haven't reached offset yet regarding *valid* new candidates
            // Actually, offset usually applies to the raw list, but here we want "next 5 suggestions".
            // So we should count valid candidates.

            // Re-fetching contact info to check name/notify
            let contactName = null;
            try {
                const contactRes = await axios.get(`${this.interfacesUrl}/whatsapp/contact`, {
                    params: { session: 'user', jid: chat.jid },
                    headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
                });
                if (contactRes.data) {
                    contactName = contactRes.data.name || contactRes.data.notify;
                }
            } catch (e) { /* ignore */ }

            // Pagination Logic: We act as a generator. We skip valid candidates until offset.
            if (skipped < offset) {
                skipped++;
                continue;
            }

            if (candidates.length >= limit) break;

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
                    knownName: contactName,
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

        let prompt = `You are a helpful assistant managing my contacts.
Analyze the following conversation snippets from WhatsApp and suggest which people I should add to my contacts.
I will provide the Known Name (from WhatsApp) if available. Use it as the primary name, but refine it if the conversation reveals a better real name (e.g. "Mom" instead of "Martha").
Also extract any contact identifiers mentioned (Email, Instagram Handle, etc).

Only suggest people who seem to be personal contacts (friends, family, colleagues, service providers). Ignore spam or strictly transactional bots.

Candidates:
`;

        for (const c of candidates) {
            const transcript = c.messages.map(m => `${m.role === 'assistant' ? 'Me' : 'Them'}: ${m.content}`).join('\n');
            const nameInfo = c.knownName ? `(Known Name: "${c.knownName}")` : '(Name Unknown)';

            prompt += `\n--- Candidate Phone: ${c.phone} ${nameInfo} ---\n${transcript.substring(0, 1500)}\n`;
        }

        prompt += `\n
Return a JSON array of objects with this schema:
{
  "phone": "extracted phone (same as candidate)",
  "suggestedName": "Real Name (e.g. 'Diego', 'Mom')",
  "relationship": "Relationship (e.g. 'Friend', 'Mother', 'Cardiologist')",
  "identifiers": { "email": "...", "instagram": "..." },
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

            // Robust Response Handling
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
                // Merge with JIDs and formatted identifiers
                return data.map(d => ({
                    ...d,
                    id: d.phone, // Temporary ID
                    jid: `${d.phone}@s.whatsapp.net`,
                    // Ensure identifiers object includes what we know
                    identifiers: {
                        whatsapp: d.phone,
                        ...(d.identifiers || {})
                    }
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
