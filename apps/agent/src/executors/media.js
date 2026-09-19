const { BaseExecutor } = require('./base');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { createWavHeader } = require('../utils/audio');
const { ConfigService } = require('../services/config-service');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchCityWeather, cityImagePrompt, WeatherError } = require('../utils/city-weather');

// Briefing pictures older than this are removed when a new one is saved.
const PICTURE_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

function withoutPlace({ place, ...rest }) { return rest; }

/** Remove briefing pictures older than two days. A failure here never stops the new one. */
function sweepOldPictures(dir) {
    try {
        const cutoff = Date.now() - PICTURE_KEEP_MS;
        for (const name of fs.readdirSync(dir)) {
            if (!/^city-.*\.png$/.test(name)) continue;
            const file = path.join(dir, name);
            try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* gone already */ }
        }
    } catch { /* the folder is new or unreadable */ }
}

class MediaExecutor extends BaseExecutor {
    async execute(name, args, context, callServices) {
        const services = this.getServices(callServices);
        const { client } = services;
        const { message, sendCallback } = context;

        switch (name) {
            case 'cityWeatherImage': {
                // The morning briefing's picture, in one step: no shell, no
                // token, no second agent turn. The tool saves it and returns
                // the path; the job sends it with the briefing as its caption.
                const { client, agent, db } = services;
                const city = String(args.city || '').trim();
                if (!city) return { success: false, error: 'A city is required.' };

                let weather;
                try {
                    weather = await fetchCityWeather(city);
                } catch (e) {
                    // No picture with made-up weather: the job sends text
                    // instead. Only our own words go back to the model.
                    const why = e instanceof WeatherError ? e.message : 'the weather lookup failed';
                    return { success: false, error: `No picture today: ${why}.` };
                }
                const place = weather.place;
                const title = place.name;

                // The folder first: a disk problem should not cost a paid picture.
                const dataRoot = process.env.DATA_DIR
                    || ((fs.existsSync('/app') && process.platform !== 'darwin') ? '/app/data' : path.join(process.cwd(), 'data'));
                // output/ is open to the shell and to sendMessage. A new name
                // for every picture: two calls in one turn run at once, and a
                // shared file would send the same picture twice. A failed day
                // leaves no file behind to be mistaken for today's.
                const dir = path.join(dataRoot, 'output', 'briefing');
                try {
                    fs.mkdirSync(dir, { recursive: true });
                } catch {
                    return { success: false, error: 'No picture today: the pictures folder could not be made.', place, weather: withoutPlace(weather) };
                }

                const imagenModel = agent.configService.getModel('IMAGE');
                let response;
                try {
                    response = await client.models.generateContent({
                        model: imagenModel,
                        contents: cityImagePrompt(title, weather),
                        // A story picture. The prompt alone does not set the shape:
                        // without this the model draws its default square. No
                        // search: the weather and the date are in the prompt.
                        config: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '9:16' } },
                    });
                } catch (e) {
                    // Our own words again: the SDK passes Node's "fetch failed"
                    // through, and the scheduler drops a reply that says it.
                    console.warn('[MediaExecutor] cityWeatherImage: the image call failed:', e?.message);
                    return { success: false, error: 'No picture today: the image model could not be reached.', place, weather: withoutPlace(weather) };
                }
                new ConfigService().logUsageFromResponse(db, imagenModel, response, message?.metadata?.chatId, 'image_gen');

                const parts = response?.candidates?.[0]?.content?.parts || [];
                const imagePart = parts.find(p => p.inlineData && String(p.inlineData.mimeType || '').startsWith('image/'));
                const bytes = imagePart && typeof imagePart.inlineData.data === 'string' ? Buffer.from(imagePart.inlineData.data, 'base64') : null;
                if (!bytes || bytes.length === 0) return { success: false, error: 'No picture today: the image model returned none.', place, weather: withoutPlace(weather) };

                sweepOldPictures(dir);
                const imagePath = path.join(dir, `city-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`);
                try {
                    fs.writeFileSync(imagePath, bytes);
                } catch {
                    return { success: false, error: 'No picture today: the picture could not be saved.', place, weather: withoutPlace(weather) };
                }
                return { success: true, imagePath, bytes: bytes.length, place, weather: withoutPlace(weather) };
            }

            case 'generateImage': {
                const { client, agent } = services;
                const imagenModel = agent.configService.getModel('IMAGE');
                console.log(`[MediaExecutor] Generating image with ${imagenModel} for prompt: "${args.prompt}"`);

                const response = await client.models.generateContent({
                    model: imagenModel,
                    contents: args.prompt,
                    config: {
                        responseModalities: ['TEXT', 'IMAGE'],
                        tools: [{ googleSearch: {} }],
                    },
                });

                const _cfg = new ConfigService();
                _cfg.logUsageFromResponse(services.db, imagenModel, response, message.metadata?.chatId, 'image_gen');

                let b64JSON = null;
                if (response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
                    const parts = response.candidates[0].content.parts;
                    const imagePart = parts.find(p => p.inlineData && p.inlineData.mimeType.startsWith('image/'));

                    if (imagePart) {
                        b64JSON = imagePart.inlineData.data;
                    }
                    if (response.candidates[0].groundingMetadata) {
                        console.log('[MediaExecutor] Grounding Metadata:', JSON.stringify(response.candidates[0].groundingMetadata, null, 2));
                    }
                }

                if (!b64JSON) {
                    throw new Error('No image returned from Imagen model.');
                }

                const imgMsg = createAssistantMessage('');
                imgMsg.parts = [{ inlineData: { mimeType: 'image/png', data: b64JSON } }];
                imgMsg.metadata = { chatId: message.metadata?.chatId };
                imgMsg.source = message.source;
                imgMsg.type = 'image';

                await sendCallback(imgMsg);

                return {
                    success: true,
                    image_base64: b64JSON,
                    info: 'Image generated and sent to user.'
                };
            }

            case 'replyWithAudio': {
                const { client, db, agent } = services;
                const text = args.text;
                const language = args.languageCode || args.language || 'detect';

                // Fetch Voice Setting (Memory -> DB -> Default)
                let voiceName = 'Kore'; // Default

                // 1. Try In-Memory Cache
                if (agent && agent.settings && agent.settings.voice) {
                    voiceName = agent.settings.voice;
                } else {
                    // 2. Fallback to DB (Start-up race or no cache)
                    try {
                        const row = db.db.prepare('SELECT value FROM agent_settings WHERE key = ?').get('voice');
                        if (row) {
                            try {
                                voiceName = JSON.parse(row.value);
                            } catch (e) {
                                voiceName = row.value;
                            }
                        }
                    } catch (err) {
                        console.error('[MediaExecutor] Failed to fetch voice setting:', err.message);
                    }
                }

                const modelName = agent.configService.getModel('TTS');
                console.log(`[MediaExecutor] Generating audio with Model: ${modelName} for: "${text.substring(0, 30)}..." (Voice: ${voiceName}, Lang: ${language})`);

                const ttsStart = Date.now();
                const audioResponse = await client.models.generateContent({
                    model: modelName,
                    contents: [{
                        parts: [{ text: `Please read the following text aloud in a natural, fast-paced, clear voice. Return ONLY the audio data. Text: "${text}"` }]
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
                const ttsDuration = Date.now() - ttsStart;
                console.log(`[MediaExecutor] TTS Generation took ${ttsDuration}ms`);

                const _cfgTts = new ConfigService();
                _cfgTts.logUsageFromResponse(db, modelName, audioResponse, message.metadata?.chatId, 'tts');

                let audioData = null;
                if (audioResponse.candidates && audioResponse.candidates[0].content && audioResponse.candidates[0].content.parts) {
                    const part = audioResponse.candidates[0].content.parts[0];
                    if (part.inlineData) {
                        audioData = part.inlineData.data;
                    }
                }

                if (!audioData) {
                    throw new Error('No audio returned from Gemini.');
                }

                const rawBuffer = Buffer.from(audioData, 'base64');
                const wavHeader = createWavHeader(rawBuffer.length, 24000, 1, 16);
                const wavBuffer = Buffer.concat([wavHeader, rawBuffer]);

                const audioMsg = createAssistantMessage('');
                audioMsg.parts = [{ inlineData: { mimeType: 'audio/wav', data: wavBuffer.toString('base64') } }];
                audioMsg.metadata = { chatId: message.metadata?.chatId };
                audioMsg.source = message.source;
                audioMsg.type = 'audio';

                await sendCallback(audioMsg);

                return { success: true, info: 'Audio sent to user.' };
            }

            default: return null;
        }
    }
}

module.exports = { MediaExecutor };
