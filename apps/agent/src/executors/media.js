const { BaseExecutor } = require('./base');
const { createAssistantMessage } = require('@deedee/shared/src/types');
const { createWavHeader } = require('../utils/audio');

class MediaExecutor extends BaseExecutor {
    async execute(name, args, context) {
        const { client } = this.services;
        const { message, sendCallback } = context;

        switch (name) {
            case 'generateImage': {
                const imagenModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3-pro-image-preview';
                console.log(`[MediaExecutor] Generating image with ${imagenModel} for prompt: "${args.prompt}"`);

                const response = await client.models.generateContent({
                    model: imagenModel,
                    contents: args.prompt,
                    config: {
                        responseModalities: ['TEXT', 'IMAGE'],
                        tools: [{ googleSearch: {} }],
                    },
                });

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

                await sendCallback(imgMsg);

                return {
                    success: true,
                    image_base64: b64JSON,
                    info: 'Image generated and sent to user.'
                };
            }

            case 'replyWithAudio': {
                const text = args.text;
                const language = args.languageCode || args.language || 'detect';
                console.log(`[MediaExecutor] Generating audio for: "${text.substring(0, 30)}..." (Lang: ${language})`);

                const modelName = process.env.GEMINI_TTS_MODEL || process.env.WORKER_FLASH || 'gemini-2.0-flash-exp';
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
                                    voiceName: "Kore"
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

                await sendCallback(audioMsg);

                return { success: true, info: 'Audio sent to user.' };
            }

            default: return null;
        }
    }
}

module.exports = { MediaExecutor };
