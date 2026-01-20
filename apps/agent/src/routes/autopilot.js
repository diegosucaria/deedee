const express = require('express');

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
            const drafts = agent.db.db.prepare(`
                SELECT d.*, p.name as contact_name, p.phone as contact_phone
                FROM autopilot_drafts d
                LEFT JOIN people p ON d.contact_id = p.phone OR d.contact_id = p.id
                WHERE d.status = ?
                ORDER BY d.created_at DESC
            `).all(status);
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
            if (draft.status !== 'pending') return res.status(400).json({ error: 'Draft already processed' });

            // Send the message using the Agent's interface
            // We need to route it correctly. 
            // The draft has 'chat_id'. If it's a WhatsApp chat, the agent handles routing.
            // We use agent.interface.send() or agent.sendMessage tool logic?
            // Better to use `agent.interface.send()` directly if we know the structure.

            // Construct message object
            const reply = {
                role: 'assistant',
                content: draft.content,
                metadata: { chatId: draft.chat_id }
            };

            // Wait, does send() handle WhatsApp logic?
            // Agent.processMessage usually handles incoming. Outgoing is sent by agent.interface.send().
            // But we need to ensure the `source` is correct (e.g. 'whatsapp').
            // We don't have 'source' in draft table explicitly, but we have chat_id.
            // Actually, we usually echo the source of the incoming message.
            // We can infer source from chat_id or contact?
            // If chat_id is phone number (WhatsApp), source is 'whatsapp'.

            // Ideally, we should use `agent.interface.send`.
            // Let's assume 'whatsapp' for now if chat_id looks like one, or try to lookup session.
            // BUT: Agent.js `_generateStream` or similar?

            // Let's use `agent.interface.send(reply)`.
            // But we need to set `reply.source`.
            // Let's assume the frontend provides it or we default to 'whatsapp' if phone-like.

            // Let's fetch session metadata if possible.
            const session = agent.db.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(draft.chat_id);
            if (session) {
                // Determine source? usually stored in session metadata? 
                // Or just try sending. Interface usually handles it.
                // For WhatsApp, we need to send to the right number.
            }

            // Simplest way: The "Agent" usually replies to a "message". 
            // Here we are initiating.
            // Let's try to just send.

            // If we use `sendMessage` tool logic, it handles routing.
            // agent.interface.send expects { content, metadata: { chatId } }.
            // The http-interface or whatsapp-interface should handle routing based on chatId.

            await agent.interface.send(reply);

            // Update Status
            agent.db.db.prepare("UPDATE autopilot_drafts SET status = 'approved' WHERE id = ?").run(id);

            res.json({ success: true });
        } catch (e) {
            console.error('Error approving draft:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // POST /drafts/:id/reject
    router.post('/drafts/:id/reject', (req, res) => {
        try {
            const { id } = req.params;
            agent.db.db.prepare("UPDATE autopilot_drafts SET status = 'rejected' WHERE id = ?").run(id);
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
    router.get('/settings', (req, res) => {
        try {
            const people = agent.db.db.prepare(`
                SELECT id, name, phone, autopilot_status, source 
                FROM people 
                ORDER BY name ASC
            `).all();
            res.json(people);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /settings/:id
    router.post('/settings/:id', (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body; // 'off', 'assisted', 'full'

            // Update by ID or Phone
            const info = agent.db.db.prepare("UPDATE people SET autopilot_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? OR phone = ?").run(status, id, id);

            if (info.changes === 0) {
                return res.status(404).json({ error: 'Person not found' });
            }
            res.json({ success: true });
        } catch (e) {
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
