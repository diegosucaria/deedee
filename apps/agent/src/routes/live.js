const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const { ConfigService } = require('../services/config-service');

function createLiveRouter(agent) {
    const router = express.Router();

    // --- GEMINI LIVE (Real-time) ---

    // 1. Get Ephemeral Token
    router.post('/token', async (req, res) => {
        try {
            const auth = new GoogleAuth({
                scopes: 'https://www.googleapis.com/auth/generative-language.retriever.readonly'
            });
            const client = await auth.getClient();
            const token = await client.getAccessToken();
            res.json({ token: token.token });
        } catch (error) {
            console.error('[Agent] Failed to generate ephemeral token:', error);
            res.status(500).json({ error: 'Token generation failed' });
        }
    });

    // 2. Get Live Config
    router.get('/config', (req, res) => {
        const config = new ConfigService();
        // Live usually expects "models/" prefix? Or just the name? 
        // Checking doc: "models/gemini-2.0-flash-exp"
        // Our config service returns "gemini-2.0-flash-exp".
        // Let's prepend it for safety if the frontend expects it.
        const modelName = config.getModel('LIVE');
        const model = `models/${modelName}`;
        res.json({ model });
    });

    return router;
}

module.exports = { createLiveRouter };
