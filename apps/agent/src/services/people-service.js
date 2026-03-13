const axios = require('axios');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { ConfigService } = require('./config-service');

class PeopleService {
    constructor(agent) {
        this.agent = agent;
        this.config = new ConfigService();
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
            // Offset applies to the suggestion list for pagination
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
                    params: { session: 'user', jid: chat.jid, limit: 100 },
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

    // --- Sync ---
    async syncFromWhatsApp() {
        const existingPeople = this.agent.db.listPeople();
        const existingPhones = new Set(existingPeople.map(p => p.phone ? p.phone.replace(/\D/g, '') : '').filter(Boolean));

        // Fetch contacts from WhatsApp (Session: user)
        // We want the user's phone book, which is mirrored in the 'user' session.
        let whatsappContacts = [];
        try {
            const res = await axios.get(`${this.interfacesUrl}/whatsapp/contacts`, {
                params: { session: 'user' },
                headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
            });
            whatsappContacts = res.data || [];
        } catch (e) {
            console.error('[People] Sync failed to fetch contacts:', e.message);
            throw new Error('Failed to fetch WhatsApp contacts');
        }

        const stats = { added: 0, skipped: 0, total: whatsappContacts.length };

        for (const contact of whatsappContacts) {
            const phone = contact.phone || contact.id.split('@')[0];
            const name = contact.name || contact.notify; // Prefer name (from phonebook), fallback to notify (public name)

            // Skip if no name or if strictly just a number (unless it's a Notify name?)
            // We want explicit contacts usually.
            if (!name) {
                stats.skipped++;
                continue;
            }

            // Check duplicate
            if (existingPhones.has(phone)) {
                stats.skipped++;
                continue;
            }

            // Create Person
            // If contact.name is set, it means it is in the phone book.
            // If only contact.notify is set, it's just a person we chatted with but didn't save.
            // Sync strictly *saved* contacts? Or all?
            // "Sync Contacts" usually implies importing the phone book.
            // WhatsApp Service 'getContacts' returns store.contacts. 
            // Baileys 'contacts.upsert' provides 'name' only if it is in the phone book (on mobile sync).
            // So checking `contact.name` is the correct filter for "Saved Contacts".
            if (!contact.name) {
                stats.skipped++;
                continue;
            }

            this.agent.db.createPerson({
                name: contact.name,
                phone: phone,
                source: 'whatsapp_sync',
                identifiers: { whatsapp: phone },
                metadata: { synced_at: new Date().toISOString() }
            });
            existingPhones.add(phone);
            stats.added++;
        }

        return stats;
    }

    async syncFromSlack() {
        const existingPeople = this.agent.db.listPeople();
        // Build lookup maps for dedup
        const slackIdToPersonId = new Map(); // slack ID → person ID (for dedup + avatar backfill)
        const nameToPersonId = new Map(); // lowercase name → person ID (for merging identifiers)
        for (const p of existingPeople) {
            if (p.identifiers?.slack) slackIdToPersonId.set(p.identifiers.slack, p.id);
            if (p.name) nameToPersonId.set(p.name.toLowerCase().trim(), p.id);
        }

        let statusRes;
        try {
            const res = await axios.get(`${this.interfacesUrl}/slack/status`, {
                headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
            });
            statusRes = res.data || { connections: [] };
        } catch (e) {
            console.error('[People] Slack sync failed to fetch status:', e.message);
            throw new Error('Failed to fetch Slack status. Is Slack connected?');
        }

        const stats = { added: 0, merged: 0, skipped: 0, total: 0 };
        const connections = statusRes.connections || [];

        for (const conn of connections) {
            if (!conn.connected) continue;

            let slackUsers = [];
            try {
                const res = await axios.get(`${this.interfacesUrl}/slack/users?teamId=${encodeURIComponent(conn.teamId)}`, {
                    headers: { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` }
                });
                slackUsers = res.data || [];
            } catch (e) {
                console.error(`[People] Slack sync failed to fetch users for ${conn.teamName}:`, e.message);
                continue;
            }

            stats.total += slackUsers.length;

            for (const user of slackUsers) {
                if (!user.name || !user.id) {
                    stats.skipped++;
                    continue;
                }

                // Skip if already synced by Slack ID — but backfill avatar if missing
                if (slackIdToPersonId.has(user.id)) {
                    if (user.avatar) {
                        const existingPersonId = slackIdToPersonId.get(user.id);
                        const avatarPath = path.join(process.cwd(), 'data', 'avatars', `${existingPersonId}.jpg`);
                        if (!fs.existsSync(avatarPath)) {
                            // Store avatar URL in metadata for lazy-load fallback
                            const existing = this.agent.db.getPerson(existingPersonId);
                            if (existing && !existing.metadata?.slack_avatar_url) {
                                const metadata = existing.metadata || {};
                                metadata.slack_avatar_url = user.avatar;
                                this.agent.db.updatePerson(existingPersonId, { metadata });
                            }
                            this.cacheSlackAvatar(existingPersonId, user.avatar).catch(e =>
                                console.error(`[People] Slack avatar backfill fail for ${existingPersonId}:`, e.message)
                            );
                        }
                    }
                    stats.skipped++;
                    continue;
                }

                // Check if person exists by name (merge identifiers)
                const nameKey = user.name.toLowerCase().trim();
                const existingId = nameToPersonId.get(nameKey);

                if (existingId) {
                    // Merge: add Slack identifier to existing person
                    const existing = this.agent.db.getPerson(existingId);
                    if (!existing) {
                        stats.skipped++;
                        continue;
                    }
                    const identifiers = existing.identifiers || {};
                    identifiers.slack = user.id;
                    identifiers.slack_team = conn.teamId;
                    const metadata = existing.metadata || {};
                    if (user.avatar) metadata.slack_avatar_url = user.avatar;
                    this.agent.db.updatePerson(existingId, { identifiers, metadata });
                    slackIdToPersonId.set(user.id, existingId);

                    // Cache Slack avatar if person doesn't have one yet
                    if (user.avatar) {
                        const avatarPath = path.join(process.cwd(), 'data', 'avatars', `${existingId}.jpg`);
                        if (!fs.existsSync(avatarPath)) {
                            this.cacheSlackAvatar(existingId, user.avatar).catch(e =>
                                console.error(`[People] Slack avatar cache fail for ${existingId}:`, e.message)
                            );
                        }
                    }

                    stats.merged++;
                    continue;
                }

                // Create new person
                const personId = this.agent.db.createPerson({
                    name: user.name,
                    source: 'slack_sync',
                    relationship: user.title || 'coworker',
                    identifiers: { slack: user.id, slack_team: conn.teamId },
                    metadata: {
                        synced_at: new Date().toISOString(),
                        slack_display_name: user.displayName,
                        slack_email: user.email,
                        slack_team_name: conn.teamName,
                        slack_avatar_url: user.avatar || ''
                    }
                });

                // Cache Slack avatar in background
                if (user.avatar) {
                    this.cacheSlackAvatar(personId, user.avatar).catch(e =>
                        console.error(`[People] Slack avatar cache fail for ${personId}:`, e.message)
                    );
                }
                slackIdToPersonId.set(user.id, personId);
                nameToPersonId.set(nameKey, personId);
                stats.added++;
            }
        }

        return stats;
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
            const modelName = this.config.getModel('FLASH');
            const response = await this.agent.client.models.generateContent({
                model: modelName,
                contents: prompt
            });

            this.config.logUsageFromResponse(this.agent.db, modelName, response, null, 'people_enrich');

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

    async cacheSlackAvatar(personId, imageUrl) {
        if (!imageUrl) return null;
        try {
            const avatarsDir = path.join(process.cwd(), 'data', 'avatars');
            if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

            const dest = path.join(avatarsDir, `${personId}.jpg`);
            await this._downloadImage(imageUrl, dest);
            return `/avatars/${personId}.jpg`;
        } catch (e) {
            console.error(`[People] Slack avatar cache failed for ${personId}:`, e.message);
            return null;
        }
    }

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
            https.get(url, (response) => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    response.resume(); // Drain response to free socket
                    return reject(new Error(`HTTP ${response.statusCode} fetching avatar`));
                }
                const file = fs.createWriteStream(dest);
                response.pipe(file);
                file.on('finish', () => {
                    file.close(resolve);
                });
                file.on('error', (err) => {
                    fs.unlink(dest, () => reject(err));
                });
            }).on('error', (err) => {
                fs.unlink(dest, () => reject(err));
            });
        });
    }
}

module.exports = { PeopleService };
