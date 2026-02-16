
const { getDreamPrompt } = require('../prompts/dream');
const { createWavHeader } = require('../utils/audio');
// We don't have access to types package easily in raw node, so we'll construct the object manually to avoid path issues
// const { createAssistantMessage } = require('@deedee/shared/src/types');

class DreamService {
    constructor(agent) {
        this.agent = agent;
    }

    async dream(force = false) {
        // 30% chance to dream
        if (!force && Math.random() > 0.3) {
            console.log('[Dream] Not dreaming tonight.');
            return { dreamed: false, reason: 'Chance check failed' };
        }

        console.log('[Dream] Starting dream sequence...');

        // 1. Gather Context
        // A. Recent Logs (Journal)
        // If executing before 6 AM, assume we are dreaming about "Yesterday"
        const now = new Date();
        const targetDate = new Date(now);
        if (now.getHours() < 6) {
            targetDate.setDate(now.getDate() - 1);
            console.log(`[Dream] Early morning detected (${now.getHours()}h). Dreaming about yesterday (${targetDate.toISOString().split('T')[0]}).`);
        }

        const journal = await this.agent.journal.getParsedJournal(targetDate);
        const recentLogs = journal ? journal.interactions.slice(-10).map(i => `[${i.timestamp}] ${i.content}`).join('\n') : "";

        // B. Random Fragments (Memory)
        const facts = this.agent.db.getAllFacts();
        // Shuffle and pick 5
        const randomFacts = facts
            .sort(() => 0.5 - Math.random())
            .slice(0, 5);

        // C. Sensory Input (Plex)
        let plexContext = "";
        try {
            // Defensive: Check if Plex MCP is available
            const tools = await this.agent.mcp.getTools();
            const hasPlex = tools.some(t => t.serverName === 'plex');

            if (hasPlex) {
                console.log('[Dream] Fetching Plex context...');

                // 1. Watch History (Last 3 items)
                let historyText = "";
                try {
                    const historyResult = await this.agent.mcp.callTool('user_get_watch_history', { limit: 3 });
                    console.log('[Dream] Watch History Result:', historyResult ? JSON.stringify(historyResult).substring(0, 100) + '...' : 'null');

                    if (historyResult && historyResult.output) {
                        const historyData = JSON.parse(historyResult.output);
                        if (historyData.items && historyData.items.length > 0) {
                            historyText = "Recently Watched:\n" + historyData.items.map(i => `- ${i.title} (${i.type})`).join('\n');
                        } else {
                            console.log('[Dream] No items in history.');
                        }
                    }
                } catch (e) {
                    console.warn('[Dream] Failed to get watch history:', e.message);
                }

                // 2. On Deck (Currently watching)
                let onDeckText = "";
                try {
                    const onDeckResult = await this.agent.mcp.callTool('user_get_on_deck', {});
                    console.log('[Dream] On Deck Result:', onDeckResult ? JSON.stringify(onDeckResult).substring(0, 100) + '...' : 'null');

                    if (onDeckResult && onDeckResult.output) {
                        const onDeckData = JSON.parse(onDeckResult.output);
                        if (onDeckData.items && onDeckData.items.length > 0) {
                            // Pick top 2
                            onDeckText = "Currently Bingeing:\n" + onDeckData.items.slice(0, 2).map(i => `- ${i.title} (${i.type})`).join('\n');
                        } else {
                            console.log('[Dream] No items on deck.');
                        }
                    }
                } catch (e) {
                    console.warn('[Dream] Failed to get On Deck:', e.message);
                }

                plexContext = [historyText, onDeckText].filter(Boolean).join('\n\n');
                console.log('[Dream] Plex Context Summary:\n', plexContext || '(Empty)');
            }
        } catch (error) {
            console.warn('[Dream] Failed to fetch Plex context:', error.message);
            plexContext = "Error fetching media context (The TV was static).";
        }

        // 2. Generate Dream Content
        const prompt = getDreamPrompt(recentLogs, randomFacts, plexContext);
        const modelName = this.agent.configService.getModel('FLASH');

        let dreamContent = null;
        try {
            const response = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{ parts: [{ text: prompt }] }],
                config: { responseMimeType: 'application/json' }
            });

            const raw = response.candidates[0].content.parts[0].text;
            const jsonStr = raw.replace(/```json\n|\n```/g, '').trim();
            dreamContent = JSON.parse(jsonStr);
        } catch (e) {
            console.error('[Dream] Failed to generate dream:', e);
            return { dreamed: false, reason: 'Generation failed' };
        }

        // 3. Output (Text or Audio)
        if (!dreamContent || !dreamContent.content) return { dreamed: false, reason: 'No dream content generated' };

        console.log(`[Dream] Generated (${dreamContent.type}): ${dreamContent.content}`);

        // Get Owner Phone
        let ownerPhone = process.env.MY_PHONE;
        const setting = this.agent.db.getAgentSetting('owner_phone');
        if (setting) ownerPhone = setting.value;

        if (!ownerPhone) {
            console.warn('[Dream] No owner phone to send dream to.');
            return { dreamed: false, reason: 'No owner phone configured' };
        }

        // Format JID
        const jid = ownerPhone.includes('@') ? ownerPhone : `${ownerPhone.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

        if (dreamContent.type === 'audio') {
            await this.sendAudioDream(jid, dreamContent.content);
        } else {
            await this.sendTextDream(jid, dreamContent.content);
        }

        return { dreamed: true, type: dreamContent.type };
    }

    getSetting(key, defaultValue) {
        if (this.agent.settings && this.agent.settings[key] !== undefined) {
            return this.agent.settings[key];
        }
        return defaultValue;
    }

    async sendTextDream(to, text) {
        const payload = {
            source: 'whatsapp',
            content: text,
            metadata: { chatId: to, session: 'assistant' },
            type: 'text'
        };
        await this.agent.interface.send(payload);
    }

    async sendAudioDream(to, text) {
        // Send Intro Text First
        await this.sendTextDream(to, "😴 I had a weird dream last night...");

        // TTS Logic
        const modelName = this.agent.configService.getModel('TTS'); // 'gemini-1.5-flash-8b' or similar usually supports TTS? 
        // Actually typically we use a specific model or the same model with AUDIO modality.
        // MediaExecutor uses: agent.configService.getModel('TTS') which defaults to 'gemini-2.0-flash-exp' or similar

        let voiceName = 'Kore';
        if (this.agent.settings && this.agent.settings.voice) {
            voiceName = this.agent.settings.voice;
        }

        try {
            const audioResponse = await this.agent.client.models.generateContent({
                model: modelName,
                contents: [{
                    parts: [{ text: `Please read the following text aloud. Return ONLY the audio data. Text: "${text}"` }]
                }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: voiceName
                            }
                        }
                    }
                }
            });

            let audioData = null;
            if (audioResponse.candidates && audioResponse.candidates[0].content && audioResponse.candidates[0].content.parts) {
                const part = audioResponse.candidates[0].content.parts[0];
                if (part.inlineData) {
                    audioData = part.inlineData.data;
                }
            }

            if (!audioData) throw new Error('No audio data received from Gemini');

            const rawBuffer = Buffer.from(audioData, 'base64');
            const wavHeader = createWavHeader(rawBuffer.length, 24000, 1, 16);
            const wavBuffer = Buffer.concat([wavHeader, rawBuffer]);

            const payload = {
                source: 'whatsapp',
                content: '', // No text content for audio message
                metadata: { chatId: to, session: 'assistant' },
                type: 'audio',
                parts: [{ inlineData: { mimeType: 'audio/wav', data: wavBuffer.toString('base64') } }]
            };

            await this.agent.interface.send(payload);

        } catch (e) {
            console.error('[DreamService] TTS Failed, falling back to text:', e);
            await this.sendTextDream(to, `(Audio generation failed, here is my dream in text): ${text}`);
        }
    }
}

module.exports = { DreamService };
