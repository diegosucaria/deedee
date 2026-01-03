const express = require('express');
const axios = require('axios');
const router = express.Router();

const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3000';

router.get('/', async (req, res) => {
    try {
        console.log('[API] Requesting Morning Briefing...');

        const prompt = `
            Generate a concise Morning Briefing for the user.
            Steps:
            1. Check the date/time.
            2. Check 'listEvents' for today.
            3. Check 'getPendingGoals'.
            4. Synthesize a friendly spoken summary (approx 3-5 sentences).
            5. Do NOT output thinking steps. Just the final message.
            6. If you find no events, say so.
        `;

        // We use the same /chat endpoint on the agent, but we construct a specific message
        const response = await axios.post(`${AGENT_URL}/chat`, {
            message: prompt,
            source: 'api_briefing', // Special source
            metadata: { chatId: 'briefing_session' }
        });

        // The agent returns a full structure, we want just the text for the response
        // Default agent response structure: { replies: [ { content: "...", type: "text" } ] }

        if (response.data && response.data.replies) {
            // Find the last text reply (assistant final answer)
            const replies = response.data.replies;
            const finalReply = replies.filter(r => r.type === 'text').pop();

            if (finalReply) {
                return res.json({ success: true, briefing: finalReply.content });
            }
        }

        res.json({ success: false, message: 'Agent returned no text.' });

    } catch (error) {
        console.error('[API] Briefing Error:', error.message);
        res.status(500).json({ error: 'Failed to generate briefing' });
    }
});

module.exports = router;
