const express = require('express');

function createSettingsRouter(agent) {
    const router = express.Router();

    // GET /internal/settings
    // Returns { key: value, key2: value2 }
    router.get('/', (req, res) => {
        try {
            const stmt = agent.db.db.prepare('SELECT key, value FROM agent_settings');
            const rows = stmt.all();

            const settings = rows.reduce((acc, row) => {
                try {
                    acc[row.key] = JSON.parse(row.value);
                } catch (e) {
                    acc[row.key] = row.value; // Fallback for non-JSON
                }
                return acc;
            }, {});

            res.json(settings);
        } catch (error) {
            console.error('[Settings] GET Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // POST /internal/settings
    // Body: { key: string, value: any, category?: string }
    router.post('/', (req, res) => {
        try {
            const { key, value, category = 'general' } = req.body;

            if (!key || value === undefined) {
                return res.status(400).json({ error: 'Missing key or value' });
            }

            const jsonValue = JSON.stringify(value);

            const stmt = agent.db.db.prepare(`
                INSERT INTO agent_settings (key, value, category, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    category = excluded.category,
                    updated_at = CURRENT_TIMESTAMP
            `);

            stmt.run(key, jsonValue, category);

            console.log(`[Settings] Updated ${key}`);

            // Notify via Socket if applicable implementation exists
            // if (agent.io) agent.io.emit('entity:update', { type: 'setting', key, value });

            res.json({ success: true, key, value });
        } catch (error) {
            console.error('[Settings] POST Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { createSettingsRouter };
