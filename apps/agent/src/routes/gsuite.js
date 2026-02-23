const express = require('express');

module.exports = function (agent) {
    const router = express.Router();

    router.get('/accounts', async (req, res) => {
        try {
            const accounts = await agent.gsuite.getAccountsStatus();
            res.json({ accounts });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/auth-url', async (req, res) => {
        try {
            const url = await agent.gsuite.getAuthUrl();
            res.json({ url });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/auth', async (req, res) => {
        try {
            const { code } = req.body;
            if (!code) return res.status(400).json({ error: 'Missing code' });

            const result = await agent.gsuite.authenticate(code);
            res.json({ result });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/disconnect', async (req, res) => {
        try {
            const { email } = req.body;
            if (!email) return res.status(400).json({ error: 'Missing email' });

            const result = await agent.gsuite.disconnectAccount(email);
            res.json({ result });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.put('/accounts/:email/label', async (req, res) => {
        try {
            const { email } = req.params;
            const { label } = req.body;
            if (!email) return res.status(400).json({ error: 'Missing email' });

            const result = await agent.gsuite.setAccountLabel(email, label);
            res.json({ result });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};
