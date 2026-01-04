const express = require('express');
const axios = require('axios');
const multer = require('multer');
const router = express.Router();

// Configure Multer (Memory Storage)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10 MB limit
});

const AGENT_URL = process.env.AGENT_URL || 'http://agent:3000';

router.post('/audio', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const source = req.body.source || 'ios_shortcut';
        const chatId = req.body.chatId || 'audio_chat';
        const mimeType = req.file.mimetype || 'audio/wav'; // Fallback

        console.log(`[AudioEndpoint] Received audio (${req.file.size} bytes, ${mimeType}) from ${source}`);

        // Convert Buffer to Base64
        const base64Audio = req.file.buffer.toString('base64');

        // Construct Agent Payload (Multimodal)
        const payload = {
            role: 'user',
            parts: [
                {
                    text: 'The user sent an audio message. Please listen to it and respond accordingly.'
                },
                {
                    inlineData: {
                        mimeType: mimeType,
                        data: base64Audio
                    }
                }
            ],
            source: source,
            metadata: { chatId: chatId }
        };

        console.log(`[AudioEndpoint] Forwarding to Agent at ${AGENT_URL}/chat...`);

        // Forward to Agent
        const response = await axios.post(`${AGENT_URL}/chat`, payload);

        // Return Agent Response
        res.json({ success: true, agentResponse: response.data });

    } catch (error) {
        console.error('[AudioEndpoint] Error:', error.message);
        res.status(500).json({ error: 'Failed to process audio', details: error.message });
    }
});

module.exports = router;
