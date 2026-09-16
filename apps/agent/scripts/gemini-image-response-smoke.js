#!/usr/bin/env node
/**
 * Checks that Gemini accepts a screenshot inside a function response as
 * `functionResponse.parts[].inlineData` (design 048, risk 1).
 *
 * Needs GOOGLE_API_KEY. Optional: GEMINI_MODEL (default gemini-3-flash-preview),
 * IMAGE_PATH (a PNG or JPEG; default: a 1x1 PNG built here).
 *
 *   GOOGLE_API_KEY=... node apps/agent/scripts/gemini-image-response-smoke.js
 *
 * Prints which shape worked: PARTS (the design's shape), SEPARATE (images as a
 * follow-up user content) or NONE. The agent's fallback chain follows the same
 * order, so the result tells us which branch runs in production.
 */
const fs = require('fs');
const path = require('path');
const { buildFunctionResponseParts, stripInlineParts, imagesAsUserContent } = require('../src/utils/function-response');

const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function main() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) { console.error('GOOGLE_API_KEY is required'); process.exit(2); }
    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

    let image = { mimeType: 'image/png', data: ONE_PX_PNG };
    if (process.env.IMAGE_PATH) {
        const p = path.resolve(process.env.IMAGE_PATH);
        image = { mimeType: p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg' : 'image/png', data: fs.readFileSync(p).toString('base64') };
    }

    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    const tool = {
        functionDeclarations: [{
            name: 'browser_take_screenshot',
            description: 'Takes a screenshot of the current page.',
            parameters: { type: 'OBJECT', properties: {} }
        }]
    };

    const chat = ai.chats.create({
        model,
        config: { tools: [tool], systemInstruction: 'When asked to look at the page, call browser_take_screenshot, then describe the image in one short sentence.' }
    });

    console.log(`[gemini-smoke] model ${model}: asking for a screenshot call...`);
    const first = await chat.sendMessage({ message: 'Look at the page and tell me what you see.' });
    const call = first.functionCalls?.[0];
    if (!call) { console.error('[gemini-smoke] model did not call the tool; reply:', first.text); process.exit(1); }
    console.log(`[gemini-smoke] model called ${call.name}`);

    const built = buildFunctionResponseParts(call, { output: 'Screenshot taken (1 image attached).' }, [image]);

    // 1. Design shape: inlineData inside functionResponse.parts
    try {
        const r = await chat.sendMessage({ message: [built.model] });
        console.log('[gemini-smoke] PARTS accepted. Reply:', (r.text || '').slice(0, 300));
        console.log('RESULT: PARTS');
        return;
    } catch (e) {
        console.warn(`[gemini-smoke] PARTS rejected: ${e.status || ''} ${e.message}`);
    }

    // 2. Fallback: text-only function response, then the image as a user content
    try {
        await chat.sendMessage({ message: stripInlineParts([built.model]) });
        const r = await chat.sendMessage({ message: imagesAsUserContent([built.model]) });
        console.log('[gemini-smoke] SEPARATE accepted. Reply:', (r.text || '').slice(0, 300));
        console.log('RESULT: SEPARATE');
        return;
    } catch (e) {
        console.warn(`[gemini-smoke] SEPARATE rejected: ${e.status || ''} ${e.message}`);
    }

    console.log('RESULT: NONE');
    process.exit(1);
}

main().catch(e => { console.error('[gemini-smoke] failed:', e.stack || e.message); process.exit(1); });
