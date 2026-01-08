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

            const ALLOWED_KEYS = ['owner_phone', 'owner_name', 'search_strategy', 'voice_settings'];
            if (!ALLOWED_KEYS.includes(key)) {
                return res.status(400).json({ error: 'Invalid config key' });
            }

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

            // Update In-Memory Cache
            if (agent.settings) {
                agent.settings[key] = value;
            }

            // Notify via Socket (Broadcast via Interfaces service)
            if (agent.interface) {
                // fire and forget
                agent.interface.broadcast('entity:update', { type: 'setting', key, value }).catch(console.error);
            }

            res.json({ success: true, key, value });
        } catch (error) {
            console.error('[Settings] POST Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });


    // POST /internal/settings/tts/preview
    // Body: { text: string, voice: string }
    router.post('/tts/preview', async (req, res) => {
        try {
            const { text, voice } = req.body;
            if (!text || !voice) {
                return res.status(400).json({ error: 'Missing text or voice' });
            }

            console.log(`[Settings] Generating TTS preview for ${voice}: "${text}"`);

            // Ensure client is ready
            if (!agent.client) {
                const { GoogleGenAI } = await import('@google/genai');
                agent.client = new GoogleGenAI({ apiKey: agent.config.googleApiKey });
            }

            const modelName = process.env.GEMINI_TTS_MODEL || process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';

            const audioResponse = await agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    parts: [{ text: `Please read this text naturally. Text: "${text}"` }]
                }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: voice
                            }
                        }
                    }
                }
            });

            let audioData = null;
            let mimeType = 'audio/wav'; // Default

            if (audioResponse.candidates && audioResponse.candidates[0].content && audioResponse.candidates[0].content.parts) {
                const part = audioResponse.candidates[0].content.parts[0];
                if (part.inlineData) {
                    audioData = part.inlineData.data;
                    // Gemini returns raw PCM for audio modality usually, or whatever implementation detail.
                    // We will wrap it below.
                }
            }

            if (!audioData) {
                throw new Error('No audio returned from Gemini.');
            }

            // Wrap in WAV header (as we do in media executor)
            const { createWavHeader } = require('../utils/audio');
            const rawBuffer = Buffer.from(audioData, 'base64');
            const wavHeader = createWavHeader(rawBuffer.length, 24000, 1, 16);
            const wavBuffer = Buffer.concat([wavHeader, rawBuffer]);

            // Re-encode to base64
            const finalAudioBase64 = wavBuffer.toString('base64');

            console.log(`[Settings] TTS Generated. MimeType: ${mimeType}, Size: ${finalAudioBase64.length}`);

            return res.json({ success: true, audio_base64: finalAudioBase64, mimeType });

        } catch (error) {
            console.error('[Settings] TTS Failed:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { createSettingsRouter };
