const express = require('express');
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3000';
// We need access to the DB to fetch the binary result of the tool
// Assuming shared volume or path
const DB_PATH = process.env.DB_PATH || '/app/data/agent.db';

function getLastImageFromDB(chatId) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
        // Find the last function response for generateImage in this chat
        // We look for messages where role='function' and parts contains 'generateImage'
        // JSON parsing in SQL is hard in SQLite, so we just get recent function messages and parse in logic
        db.all(`SELECT * FROM messages WHERE chat_id = ? AND role = 'function' ORDER BY timestamp DESC LIMIT 5`, [chatId], (err, rows) => {
            db.close();
            if (err) return reject(err);
            if (!rows || rows.length === 0) return resolve(null);

            for (const row of rows) {
                try {
                    const parts = JSON.parse(row.parts || row.content); // Handle formatting
                    // Look for functionResponse
                    if (Array.isArray(parts)) {
                        for (const p of parts) {
                            if (p.functionResponse && p.functionResponse.name === 'generateImage') {
                                const res = p.functionResponse.response;
                                if (res && res.result && res.result.image_base64) {
                                    return resolve(res.result.image_base64);
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error parsing DB message:', e);
                }
            }
            resolve(null);
        });
    });
}

router.get('/', async (req, res) => {
    const city = req.query.city;
    if (!city) return res.status(400).json({ error: 'City parameter is required' });

    const chatId = `api_city_image_${Date.now()}`;

    try {
        console.log(`[API] Generating City Image for ${city}...`);

        const prompt = `
            Task: Generate a specialized weather image for city: "${city}".
            
            1. First, determine the current weather and temperature for ${city}.
            
            2. Then, call the 'generateImage' tool with this EXACT prompt template (fill in brackets):
            
            "CITY=${city}, [COUNTRY]
            Present a clear, 45° top-down isometric miniature 3D cartoon scene of ${city}, featuring its most iconic landmarks and architectural elements. Use soft, refined textures with realistic PBR materials and gentle, lifelike lighting and shadows. Integrate the current weather conditions ([WEATHER_DESCRIPTION]) directly into the city environment to create an immersive atmospheric mood.
            Use a clean, minimalistic composition with a soft, solid-colored background.
            At the top-center, place the title “${city}” in large bold text, a prominent weather icon beneath it, then the date (small text) and temperature ([TEMP]) (medium text).
            All text must be centered with consistent spacing, and may subtly overlap the tops of the buildings.
            The city cartoon should not reach the borders of the image
            Instagram Story size, 1080x1920 dimension."

            3. Return only "Image generated" when done.
        `;

        // 1. Trigger Agent
        await axios.post(`${AGENT_URL}/chat`, {
            content: prompt,
            source: 'api_image',
            metadata: { chatId: chatId }
        });

        // 2. Fetch Result from DB
        // Give it a moment? The axios call waits for Agent to finish, so DB should be populated.
        const base64 = await getLastImageFromDB(chatId);

        if (base64) {
            const imgBuffer = Buffer.from(base64, 'base64');
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': imgBuffer.length
            });
            res.end(imgBuffer);
        } else {
            res.status(500).json({ error: 'Agent executed task but no image data found in memory.' });
        }

    } catch (error) {
        console.error('[API] City Image Error:', error.message);
        res.status(500).json({ error: 'Failed to generate image' });
    }
});

module.exports = router;
