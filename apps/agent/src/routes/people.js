const express = require('express');
const fs = require('fs');
const path = require('path');
const { PeopleService } = require('../services/people-service');

const createPeopleRouter = (agent) => {
    const router = express.Router();
    const peopleService = new PeopleService(agent);

    // List People
    router.get('/', (req, res) => {
        try {
            const people = agent.db.listPeople();
            res.json(people);
        } catch (error) {
            console.error('[People] List Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Create Person
    router.post('/', async (req, res) => {
        try {
            const id = agent.db.createPerson(req.body);

            // Auto-Cache Avatar if source is whatsapp
            if (req.body.source === 'whatsapp') {
                const phone = req.body.phone; // Format: 1234567890
                if (phone) {
                    const jid = `${phone}@s.whatsapp.net`;
                    // Run in background to avoid delaying response
                    peopleService.cacheAvatar(id, jid)
                        .then(path => {
                            if (path) console.log(`[People] Cached avatar for ${id}`);
                        })
                        .catch(e => console.error('[People] Avatar cache fail:', e));
                }
            }

            res.json({ id });
        } catch (error) {
            console.error('[People] Create Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Get Person
    router.get('/:id', (req, res) => {
        try {
            const person = agent.db.getPerson(req.params.id);
            if (!person) return res.status(404).json({ error: 'Person not found' });
            res.json(person);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Get Avatar
    router.get('/:id/avatar', (req, res) => {
        const avatarPath = path.join(process.cwd(), 'data', 'avatars', `${req.params.id}.jpg`);
        if (fs.existsSync(avatarPath)) {
            res.sendFile(avatarPath);
        } else {
            // Send default or 404
            res.status(404).send('No avatar');
        }
    });

    // Update Person
    router.put('/:id', (req, res) => {
        try {
            agent.db.updatePerson(req.params.id, req.body);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Delete Person
    router.delete('/:id', (req, res) => {
        try {
            agent.db.deletePerson(req.params.id);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Smart Learn Trigger
    router.post('/sync', async (req, res) => {
        try {
            const stats = await agent.peopleService.syncFromWhatsApp();
            res.json({ success: true, stats });
        } catch (error) {
            console.error('[People] Sync Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/learn', async (req, res) => {
        try {
            const { limit, offset } = req.body;
            const candidates = await peopleService.suggestPeopleFromHistory({
                limit: parseInt(limit) || 5,
                offset: parseInt(offset) || 0
            });
            res.json({ candidates });
        } catch (error) {
            console.error('[People] Learn Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};

module.exports = { createPeopleRouter };
