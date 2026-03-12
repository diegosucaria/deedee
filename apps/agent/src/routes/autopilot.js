const express = require('express');
const axios = require('axios');

function createAutopilotRouter(agent) {
    const router = express.Router();

    // Middleware check
    router.use((req, res, next) => {
        if (!agent) return res.status(503).json({ error: 'Agent not initialized' });
        next();
    });

    // --- DRAFTS ---

    // GET /drafts?status=pending
    router.get('/drafts', (req, res) => {
        try {
            const status = req.query.status || 'pending';
            // Include 'partially_sent' drafts when querying for 'pending' so they remain actionable
            const statuses = status === 'pending' ? ['pending', 'partially_sent'] : [status];
            const placeholders = statuses.map(() => '?').join(', ');
            const drafts = agent.db.db.prepare(`
                SELECT d.*, p.name as contact_name, p.phone as contact_phone,
                CASE WHEN d.context_content IS NOT NULL THEN d.context_content ELSE (SELECT content FROM messages WHERE chat_id = d.chat_id AND role != 'assistant' ORDER BY timestamp DESC LIMIT 1) END as context_message
                FROM autopilot_drafts d
                LEFT JOIN people p ON d.contact_id = p.phone OR d.contact_id = p.id
                WHERE d.status IN (${placeholders})
                ORDER BY d.created_at DESC
            `).all(...statuses);
            res.json(drafts);
        } catch (e) {
            console.error('Error fetching drafts:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /drafts/:id/approve
    router.post('/drafts/:id/approve', async (req, res) => {
        try {
            const { id } = req.params;
            const draft = agent.db.db.prepare('SELECT * FROM autopilot_drafts WHERE id = ?').get(id);

            if (!draft) return res.status(404).json({ error: 'Draft not found' });
            if (draft.status !== 'pending' && draft.status !== 'partially_sent') {
                return res.status(400).json({ error: 'Draft already processed' });
            }

            // Resolve Source
            // Per user request: "messages should be sent 'from me'"
            // So we FORCE the 'user' session if the target is WhatsApp.
            let source = 'whatsapp:user';

            // Check if it's actually WhatsApp first
            const isWhatsApp = draft.chat_id.endsWith('@s.whatsapp.net') || draft.chat_id.endsWith('@g.us') || draft.chat_id.endsWith('@lid');
            if (!isWhatsApp) {
                // Fallback if we support other platforms later
                source = 'web';
            }

            // Construct message list from SPLIT markers
            const messages = draft.content.split(/\[\s*SPLIT\s*\]/i).map(m => m.trim()).filter(m => m);

            // Skip messages that were already sent in a previous partial attempt
            const alreadySent = draft.sent_count || 0;
            let sentCount = alreadySent;

            for (let i = alreadySent; i < messages.length; i++) {
                const reply = {
                    role: 'assistant',
                    content: messages[i],
                    source: source,
                    metadata: {
                        chatId: draft.chat_id,
                        session: 'user'
                    }
                };

                try {
                    await agent.interface.send(reply);
                    sentCount++;

                    // Persist progress after each successful send so we never re-send on retry
                    agent.db.db.prepare(
                        "UPDATE autopilot_drafts SET sent_count = ?, status = 'partially_sent' WHERE id = ?"
                    ).run(sentCount, id);
                } catch (sendErr) {
                    console.error(`[Autopilot] Failed sending message ${i + 1}/${messages.length} for draft ${id}:`, sendErr.message);
                    // Progress already persisted for previously sent messages; bail out
                    return res.status(500).json({
                        error: 'Failed to send all messages',
                        sent: sentCount,
                        total: messages.length
                    });
                }

                // Delay between multiple messages
                if (messages.length > 1 && i < messages.length - 1) {
                    await new Promise(r => setTimeout(r, 800));
                }
            }

            // All messages sent successfully
            console.log(`[Autopilot] Approved draft ${id}. Sent ${sentCount}/${messages.length} messages.`);
            agent.db.db.prepare(
                "UPDATE autopilot_drafts SET status = 'approved', sent_count = ? WHERE id = ?"
            ).run(sentCount, id);

            res.json({ success: true });
        } catch (e) {
            console.error('Error approving draft:', e);
            res.status(500).json({ error: 'Failed to process draft' });
        }
    });

    // DELETE /drafts/:id (Delete draft)
    router.delete('/drafts/:id', (req, res) => {
        try {
            const { id } = req.params;
            agent.db.db.prepare("DELETE FROM autopilot_drafts WHERE id = ?").run(id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // PUT /drafts/:id (Edit content)
    router.put('/drafts/:id', (req, res) => {
        try {
            const { id } = req.params;
            const { content } = req.body;
            agent.db.db.prepare("UPDATE autopilot_drafts SET content = ? WHERE id = ?").run(content, id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // --- SETTINGS ---

    // GET /settings
    // GET /settings (List all people + status, sorted by Style > Recency)
    router.get('/settings', async (req, res) => {
        try {
            // 1. Get People from Agent DB
            // Preserve existing filters (sys_, sch_)
            const people = agent.db.db.prepare(`
                SELECT id, name, phone, relationship, autopilot_status, autopilot_expires_at, source, metadata 
                FROM people 
                WHERE (name IS NULL OR (name NOT LIKE 'sys_%' AND name NOT LIKE 'sch_%'))
            `).all();

            // 2. Fetch Recent Chats from Interfaces (Source of Truth for Recency)
            // Local Agent DB history is sparse/incomplete for incoming messages
            let recentMap = {};
            try {
                const interfacesUrl = process.env.INTERFACES_URL || 'http://localhost:5000';
                const headers = { 'Authorization': `Bearer ${process.env.DEEDEE_API_TOKEN}` };
                // Fetch ample history to cover most contacts
                const recents = await axios.get(`${interfacesUrl}/whatsapp/recent?limit=200`, { headers });

                if (recents.data && Array.isArray(recents.data)) {
                    recents.data.forEach(chat => {
                        if (chat.remote_jid && chat.lastTimestamp) {
                            recentMap[chat.remote_jid] = chat.lastTimestamp;
                        }
                    });
                }
            } catch (err) {
                console.warn('[Autopilot] Failed to fetch recent chats from Interfaces for sorting:', err.message);
            }

            // 3. Enrich & Calculate Properties
            const enriched = people.map(p => {
                let has_style = false;
                let is_pinned = false; // [NEW] Pinned Status
                try {
                    let meta = JSON.parse(p.metadata || '{}');
                    // Handle double-encoded legacy data
                    if (typeof meta === 'string') {
                        try { meta = JSON.parse(meta); } catch (e) { }
                    }
                    if (meta && meta.style_profile && meta.style_profile.length > 10) has_style = true;
                    if (meta && meta.is_pinned) is_pinned = true;
                } catch (e) { }

                // Resolve Timestamp
                let ts = 0;
                if (p.phone) {
                    const phone = p.phone.replace(/\D/g, '');
                    const jid = `${phone}@s.whatsapp.net`;
                    if (recentMap[jid]) {
                        ts = recentMap[jid];
                    }
                }

                return {
                    ...p,
                    has_style: has_style,
                    is_pinned: is_pinned, // [NEW]
                    last_message_at: ts * 1000 // Convert Seconds to MS
                };
            });

            // 4. Sort: Pinned > Style > Recency
            enriched.sort((a, b) => {
                // Priority 0: Pinned (High Priority)
                if (a.is_pinned && !b.is_pinned) return -1;
                if (!a.is_pinned && b.is_pinned) return 1;

                // Priority 1: Has Style Learned
                if (a.has_style && !b.has_style) return -1;
                if (!a.has_style && b.has_style) return 1;

                // Priority 2: Recency (Newest First)
                return b.last_message_at - a.last_message_at;
            });

            res.json(enriched);
        } catch (e) {
            console.error('[Autopilot] Settings error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /settings/:id
    router.post('/settings/:id', (req, res) => {
        try {
            const { id } = req.params;
            const { status, duration } = req.body; // 'off', 'assisted', 'full', duration in minutes

            let expiresAt = null;
            if (duration && duration > 0) {
                // Calculate expiry
                const now = new Date();
                expiresAt = new Date(now.getTime() + duration * 60000).toISOString();
            }

            // Update by ID or Phone
            const info = agent.db.db.prepare("UPDATE people SET autopilot_status = ?, autopilot_expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR phone = ?").run(status, expiresAt, id, id);

            if (info.changes === 0) {
                return res.status(404).json({ error: 'Person not found' });
            }
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /settings/:id/pin (Toggle Pin)
    router.post('/settings/:id/pin', (req, res) => {
        try {
            const { id } = req.params;
            const { isPinned } = req.body; // boolean

            const person = agent.db.getPerson(id);
            if (!person) return res.status(404).json({ error: 'Person not found' });

            // Update Metadata
            let meta = {};
            try {
                // Handle existing metadata carefully (legacy string/object mix)
                // db.getPerson ALREADY parses metadata if it can. But we must be safe.
                if (typeof person.metadata === 'object' && person.metadata !== null) {
                    meta = person.metadata;
                } else if (typeof person.metadata === 'string') {
                    meta = JSON.parse(person.metadata);
                    // Double encode check
                    if (typeof meta === 'string') meta = JSON.parse(meta);
                }
            } catch (e) { }

            meta.is_pinned = !!isPinned; // Force boolean

            // Save
            agent.db.updatePerson(person.id, { metadata: meta });

            res.json({ success: true });
        } catch (e) {
            console.error('Error toggling pin:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- STYLE PROFILE ---

    // GET /style
    router.get('/style', (req, res) => {
        try {
            const profile = agent.impersonationService.getStyleProfile();
            res.json({ profile });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /style (Update manually)
    router.post('/style', (req, res) => {
        try {
            const { profile } = req.body;
            agent.impersonationService.saveStyleProfile(profile);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /style/analyze (Trigger global analysis)
    router.post('/style/analyze', async (req, res) => {
        try {
            const profile = await agent.impersonationService.analyzeGlobalStyle();
            res.json({ profile });
        } catch (e) {
            console.error('Error analyzing global style:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- CONTACT STYLE ---

    // GET /style/:contactId
    router.get('/style/:contactId', (req, res) => {
        try {
            const { contactId } = req.params;
            // Decode potential JID
            const id = decodeURIComponent(contactId);
            const profile = agent.impersonationService.getContactStyle(id);
            res.json({ profile });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /style/:contactId
    router.post('/style/:contactId', (req, res) => {
        try {
            const { contactId } = req.params;
            const { profile } = req.body;
            const id = decodeURIComponent(contactId);

            agent.impersonationService.saveContactStyle(id, profile);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /style/:contactId/analyze
    router.post('/style/:contactId/analyze', async (req, res) => {
        try {
            const { contactId } = req.params;
            const id = decodeURIComponent(contactId);

            const profile = await agent.impersonationService.analyzeContactStyle(id);
            res.json({ profile });
        } catch (e) {
            console.error('Error analyzing contact style:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return router;
}

module.exports = { createAutopilotRouter };
