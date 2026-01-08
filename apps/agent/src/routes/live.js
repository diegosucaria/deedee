const express = require('express');
const { GoogleAuth } = require('google-auth-library');

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
        const model = process.env.WORKER_LIVE || 'models/gemini-2.0-flash-exp';
        res.json({ model });
    });

    return router;
}

module.exports = { createLiveRouter };
